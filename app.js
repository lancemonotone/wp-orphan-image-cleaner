#!/usr/bin/env node

/**
 * WordPress Orphaned Image Sizes Cleanup Tool (wp-orphan-image-cleaner)
 *
 * Identifies and removes orphaned image size files (thumbnails without parent images)
 * with backup and restore functionality.
 *
 * Usage:
 *   node app.js --dry-run           # Preview what would be deleted
 *   node app.js --delete           # Actually delete with backup
 *   node app.js --restore ZIPFILE  # Restore from backup
 */

const fs = require("fs").promises;
const fsSync = require("fs");
const path = require("path");

// Configuration
const UPLOADS_PATH = "../wp-content/uploads";
const BACKUP_PREFIX = "wp-oic";
const LOGS_DIR = "./logs";

// Image size patterns (based on your WordPress analysis)
// All patterns extract the ROOT parent name (original file) for proper orphan detection
const SIZE_PATTERNS = [
  // SIZE VARIANTS (with dimensions) - look for original parent
  /^(.+)-(\d+)x(\d+)(\.(jpg|jpeg|png|gif|webp))$/i, // Standard: image-300x200.jpg
  /^(.+)-scaled-(\d+)x(\d+)(\.(jpg|jpeg|png|gif|webp))$/i, // Scaled: image-scaled-300x200.jpg → looks for image.jpg
  /^(.+)-e\d+-(\d+)x(\d+)(\.(jpg|jpeg|png|gif|webp))$/i, // Edited: image-e1234567890-300x200.jpg
  /^(.+)-scaled-e\d+-(\d+)x(\d+)(\.(jpg|jpeg|png|gif|webp))$/i, // Scaled+Edited: image-scaled-e1234567890-300x200.jpg → looks for image.jpg
  /^(.+)-(\d+)x(\d+)(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP copies: image-300x200.jpg.webp
  /^(.+)-scaled-(\d+)x(\d+)(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP scaled: image-scaled-300x200.jpg.webp → looks for image.jpg
  /^(.+)-e\d+-(\d+)x(\d+)(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP edited: image-e1234567890-300x200.jpg.webp
  /^(.+)-scaled-e\d+-(\d+)x(\d+)(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP scaled+edited: image-scaled-e1234567890-300x200.jpg.webp → looks for image.jpg
];

// PARENT FILE patterns - files that should have original parents but might be orphaned
const PARENT_PATTERNS = [
  /^(.+)-scaled(\.(jpg|jpeg|png|gif|webp))$/i, // Scaled parents: image-scaled.jpg → looks for image.jpg
  /^(.+)-scaled(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP of scaled parents: image-scaled.jpg.webp → looks for image.jpg
  /^(.+)-e\d+(\.(jpg|jpeg|png|gif|webp))$/i, // Edited parents: image-e1234567890.jpg → looks for image.jpg
  /^(.+)-e\d+(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP of edited parents: image-e1234567890.jpg.webp → looks for image.jpg
  /^(.+)-scaled-e\d+(\.(jpg|jpeg|png|gif|webp))$/i, // Scaled+edited parents: image-scaled-e1234567890.jpg → looks for image.jpg
  /^(.+)-scaled-e\d+(\.(jpg|jpeg|png|gif)\.webp)$/i, // WebP of scaled+edited parents: image-scaled-e1234567890.jpg.webp → looks for image.jpg
];

class OrphanedImageCleaner {
  constructor() {
    this.orphanedFiles = [];
    this.totalScanned = 0;
    this.totalSize = 0;
    this.backupPath = "";
    this.logPath = "";
    this.csvRows = [];

    // Parse command line arguments
    const args = process.argv.slice(2);
    this.isDryRun = args.includes("--dry-run");
    this.shouldClean = args.includes("--clean");
    this.shouldRestore = args.includes("--restore");
    this.deleteBackups = args.includes("--delete");
    this.restoreFile = this.shouldRestore
      ? args[args.indexOf("--restore") + 1]
      : null;
  }

  /**
   * Initialize CSV logging
   */
  async initializeLogging() {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);

    this.logPath = path.join(LOGS_DIR, `${BACKUP_PREFIX}-${timestamp}.csv`);

    // Create logs directory if it doesn't exist
    await fs.mkdir(LOGS_DIR, { recursive: true });

    // CSV header
    const header =
      "timestamp,operation,file_path,file_size_bytes,file_size_formatted,dimensions,base_name,status,error_message\n";
    await fs.writeFile(this.logPath, header);

    console.log(`📝 Logging to: ${this.logPath}`);
  }

  /**
   * Log entry to CSV
   */
  async logToCsv(
    operation,
    filePath = "",
    fileSize = 0,
    dimensions = "",
    baseName = "",
    status = "",
    errorMessage = ""
  ) {
    const timestamp = new Date().toISOString();
    const formattedSize = fileSize > 0 ? this.formatBytes(fileSize) : "";

    const row =
      [
        timestamp,
        operation,
        filePath,
        fileSize,
        formattedSize,
        dimensions,
        baseName,
        status,
        errorMessage,
      ]
        .map((field) => `"${String(field).replace(/"/g, '""')}"`)
        .join(",") + "\n";

    await fs.appendFile(this.logPath, row);
  }

  /**
   * Main execution method
   */
  async run() {
    const args = process.argv.slice(2);

    if (args.includes("--help") || args.length === 0) {
      this.showHelp();
      return;
    }

    // Validate that only recognized flags are provided
    const validFlags = ["--dry-run", "--clean", "--restore", "--delete"];
    const invalidFlags = args.filter((arg, index) => {
      // Skip filename after --restore
      if (index > 0 && args[index - 1] === "--restore") {
        return false;
      }
      // Check if it's a flag (starts with --) and not in valid list
      return arg.startsWith("--") && !validFlags.includes(arg);
    });

    if (invalidFlags.length > 0) {
      console.log(`❌ Invalid flag(s): ${invalidFlags.join(", ")}`);
      console.log("Use --help for valid options.\n");
      this.showHelp();
      return;
    }

    // Validate that at least one action flag is provided
    if (!this.isDryRun && !this.shouldClean && !this.shouldRestore) {
      console.log("❌ No action specified. Please provide an action flag:");
      console.log("   --dry-run    (scan only)");
      console.log("   --clean      (delete with backup)");
      console.log("   --restore    (restore from backup)\n");
      this.showHelp();
      return;
    }

    console.log("🔍 WordPress Orphaned Image Cleaner");
    console.log("=====================================");

    // Show active flags and expected behavior
    const activeFlags = [];
    if (this.isDryRun) activeFlags.push("--dry-run");
    if (this.shouldClean) activeFlags.push("--clean");
    if (this.shouldRestore) activeFlags.push("--restore");
    if (this.deleteBackups) activeFlags.push("--delete");

    if (activeFlags.length > 0) {
      console.log(`🔧 Options detected: ${activeFlags.join(" ")}`);

      if (this.shouldRestore) {
        console.log(`🔄 Restore mode: Files will be restored from backup ZIP`);
        if (this.deleteBackups) {
          console.log(
            `🗑️  Backup cleanup: ZIP file will be deleted after restore`
          );
        } else {
          console.log(
            `💾 Backup preservation: ZIP file will be kept after restore (default)`
          );
        }
      } else if (this.isDryRun) {
        console.log(`👁️  Preview mode: Files will be scanned but not deleted`);
      } else if (this.shouldClean) {
        console.log(
          `🗑️  Clean mode: Orphaned files will be deleted with backup`
        );
        if (this.deleteBackups) {
          console.log(
            `🧹 Backup cleanup: Temporary backup directory will be cleaned up`
          );
        } else {
          console.log(
            `💾 Backup preservation: Backup directory and ZIP will be kept (default)`
          );
        }
      }
      console.log(""); // Add blank line
    }

    await this.initializeLogging();

    if (this.shouldRestore) {
      if (!this.restoreFile) {
        // Auto-find latest backup if no file specified
        const latestBackup = await this.findLatestBackup();
        if (!latestBackup) {
          console.log("❌ No backup files found to restore from");
          console.log("   You can also specify a backup ZIP file manually:");
          console.log(
            "   Example: node app.js --restore wp-oic-2024-01-15T10-30-00.zip"
          );
          return;
        }
        console.log(`🔍 Auto-detected latest backup: ${latestBackup}`);
        await this.restoreFromBackup(latestBackup);
      } else {
        await this.restoreFromBackup(this.restoreFile);
      }
      return;
    }

    console.log(`📊 Scanning for orphaned images...`);
    await this.scanForOrphans();

    if (this.orphanedFiles.length === 0) {
      console.log("✅ No orphaned images found!");
      await this.logToCsv(
        "SCAN_COMPLETE",
        "",
        0,
        "",
        "",
        "SUCCESS",
        "No orphaned files found"
      );
      return;
    }

    this.displayResults(this.isDryRun);

    if (this.isDryRun) {
      console.log(
        "\n🔍 This was a dry run. Use --delete to actually delete files."
      );
      await this.logToCsv(
        "SCAN_COMPLETE",
        "",
        this.totalSize,
        "",
        "",
        "SUCCESS",
        `Dry run completed. Found ${
          this.orphanedFiles.length
        } orphaned files totaling ${this.formatBytes(this.totalSize)}`
      );
    } else if (this.shouldClean) {
      await this.deleteWithBackup();
    }
  }

  /**
   * Show help information
   */
  showHelp() {
    console.log(`
🔍 WordPress Orphaned Image Cleaner
====================================

This script identifies and removes orphaned image files that exist on disk
but have no corresponding entries in the WordPress database.

USAGE:
  node app.js [options]

OPTIONS:
  --help           Show this help message
  --dry-run        Scan and report orphaned files without deleting them
  --clean          Delete orphaned files with backup (keeps backup files by default)
  --delete         Delete backup files after operations (use with --clean or --restore)
  --restore [zip]  Restore files from backup ZIP file (auto-detects latest if no file specified)

EXAMPLES:
  # Show help
  node app.js

  # Scan for orphaned files (dry run)
  node app.js --dry-run

  # Delete orphaned files with backup (keeps backup files)
  node app.js --clean

  # Delete orphaned files and cleanup backup files
  node app.js --clean --delete

  # Restore from latest backup (keeps backup ZIP)
  node app.js --restore

  # Restore from latest backup and delete backup ZIP
  node app.js --restore --delete

  # Restore from specific backup
  node app.js --restore wp-oic-2024-01-15T10-30-00.zip

NOTES:
  - Backup ZIP files are created in the uploads directory
  - CSV logs are saved to ./logs/ directory
  - Backup files are kept by default for safety
  - Use --delete flag to cleanup backup files after operations
  - Always test with --dry-run first on production sites
`);
  }

  /**
   * Scan uploads directory for orphaned image files
   */
  async scanForOrphans() {
    console.log("🔍 Scanning for orphaned image size files...");
    console.log(`📁 Scanning directory: ${UPLOADS_PATH}`);

    await this.scanDirectory(UPLOADS_PATH);

    console.log(`\n📊 Scan complete!`);
    console.log(`   Total files scanned: ${this.totalScanned}`);
    console.log(`   Orphaned files found: ${this.orphanedFiles.length}`);
    console.log(`   Total orphaned size: ${this.formatBytes(this.totalSize)}`);
  }

  /**
   * Recursively scan directory for image files
   * Only scans WordPress year/month folders (YYYY/MM pattern)
   */
  async scanDirectory(dirPath) {
    try {
      const items = await fs.readdir(dirPath, { withFileTypes: true });

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);

        if (item.isDirectory()) {
          // Only scan year/month folders (WordPress media organization)
          if (this.shouldScanDirectory(dirPath, item.name)) {
            await this.scanDirectory(fullPath);
          }
        } else if (item.isFile() && this.isImageFile(item.name)) {
          this.totalScanned++;
          await this.checkIfOrphaned(fullPath, item.name);
        }
      }
    } catch (error) {
      console.warn(`⚠️  Could not scan directory ${dirPath}: ${error.message}`);
    }
  }

  /**
   * Check if we should scan a directory based on WordPress media organization
   */
  shouldScanDirectory(parentPath, dirName) {
    const relativePath = path.relative(UPLOADS_PATH, parentPath);

    // Root uploads directory - scan year folders (YYYY)
    if (relativePath === "" || relativePath === ".") {
      return /^\d{4}$/.test(dirName); // Match 2020, 2021, 2022, etc.
    }

    // Year directory - scan month folders (MM)
    if (/^\d{4}$/.test(path.basename(parentPath))) {
      return /^(0[1-9]|1[0-2])$/.test(dirName); // Match 01-12
    }

    // Don't scan deeper than year/month
    return false;
  }

  /**
   * Check if a file is an image file
   */
  isImageFile(filename) {
    return (
      /\.(jpg|jpeg|png|gif|webp)$/i.test(filename) ||
      /\.(jpg|jpeg|png|gif)\.webp$/i.test(filename)
    );
  }

  /**
   * Check if an image file is an orphaned size variant or parent file
   */
  async checkIfOrphaned(filePath, filename) {
    // Check SIZE VARIANTS first (files with dimensions)
    for (const pattern of SIZE_PATTERNS) {
      const match = filename.match(pattern);
      if (match) {
        const baseName = match[1];
        const extension = match[4];
        const directory = path.dirname(filePath);

        // For WebP copies (e.g., image-300x200.jpg.webp), we need to look for:
        // 1. Original parent (image.jpg)
        // 2. WebP parent (image.jpg.webp)
        const isWebPCopy = extension.includes(".webp");
        const originalExtension = isWebPCopy
          ? extension.replace(".webp", "")
          : extension;

        // Check for parent files
        let parentExists = false;
        try {
          const dirContents = await fs.readdir(directory);
          parentExists = dirContents.some((file) => {
            if (!file.startsWith(baseName)) return false;

            // Check if this file matches size patterns (skip if it does)
            if (SIZE_PATTERNS.some((p) => p.test(file))) return false;
            if (PARENT_PATTERNS.some((p) => p.test(file))) return false;

            // For WebP copies, look for either original parent or WebP parent
            if (isWebPCopy) {
              return (
                file === `${baseName}${originalExtension}` || // Original parent
                file === `${baseName}${extension}`
              ); // WebP parent
            } else {
              // For regular files, just match the extension
              return file.endsWith(extension);
            }
          });
        } catch (error) {
          // Continue if can't read directory
        }

        if (!parentExists) {
          const stat = await fs.stat(filePath);
          const orphanedFile = {
            path: filePath,
            filename: filename,
            size: stat.size,
            baseName: baseName,
            dimensions: `${match[2]}x${match[3]}`,
            relativePath: path.relative(UPLOADS_PATH, filePath),
          };

          this.orphanedFiles.push(orphanedFile);
          this.totalSize += stat.size;

          // Log orphaned file found
          await this.logToCsv(
            "ORPHAN_FOUND",
            filePath,
            stat.size,
            orphanedFile.dimensions,
            baseName,
            "FOUND",
            ""
          );
        }
        return; // Found a match, stop checking
      }
    }

    // Check PARENT FILES (scaled, edited, etc. without dimensions)
    for (const pattern of PARENT_PATTERNS) {
      const match = filename.match(pattern);
      if (match) {
        const baseName = match[1];
        const extension = match[2];
        const directory = path.dirname(filePath);

        // For WebP copies (e.g., image-scaled.jpg.webp), we need to look for:
        // 1. Original parent (image.jpg)
        // 2. WebP parent (image.jpg.webp)
        const isWebPCopy = extension.includes(".webp");
        const originalExtension = isWebPCopy
          ? extension.replace(".webp", "")
          : extension;

        // Check for original parent files
        let parentExists = false;
        try {
          const dirContents = await fs.readdir(directory);
          parentExists = dirContents.some((file) => {
            if (!file.startsWith(baseName)) return false;

            // Skip other generated files (size variants, other parent files)
            if (SIZE_PATTERNS.some((p) => p.test(file))) return false;
            if (PARENT_PATTERNS.some((p) => p.test(file))) return false;

            // For WebP copies, look for either original parent or WebP parent
            if (isWebPCopy) {
              return (
                file === `${baseName}${originalExtension}` || // Original parent
                file === `${baseName}${extension}`
              ); // WebP parent
            } else {
              // For regular files, just match the extension
              return file.endsWith(extension);
            }
          });
        } catch (error) {
          // Continue if can't read directory
        }

        if (!parentExists) {
          const stat = await fs.stat(filePath);
          const orphanedFile = {
            path: filePath,
            filename: filename,
            size: stat.size,
            baseName: baseName,
            dimensions: "parent", // Mark as parent file, not size variant
            relativePath: path.relative(UPLOADS_PATH, filePath),
          };

          this.orphanedFiles.push(orphanedFile);
          this.totalSize += stat.size;

          // Log orphaned file found
          await this.logToCsv(
            "ORPHAN_FOUND",
            filePath,
            stat.size,
            "parent",
            baseName,
            "FOUND",
            ""
          );
        }
        return; // Found a match, stop checking
      }
    }
  }

  /**
   * Display scan results
   */
  displayResults(isDryRun = false) {
    console.log("\n" + "=".repeat(60));
    console.log(isDryRun ? "🔍 DRY RUN RESULTS" : "📋 ORPHANED FILES FOUND");
    console.log("=".repeat(60));

    if (this.orphanedFiles.length === 0) {
      console.log("✅ No orphaned image size files found!");
      return;
    }

    // Group by directory for better organization
    const byDirectory = {};
    this.orphanedFiles.forEach((file) => {
      const dir = path.dirname(file.relativePath);
      if (!byDirectory[dir]) byDirectory[dir] = [];
      byDirectory[dir].push(file);
    });

    Object.keys(byDirectory)
      .sort()
      .forEach((dir) => {
        console.log(`\n📁 ${dir}/`);
        byDirectory[dir].forEach((file) => {
          console.log(
            `   🗑️  ${file.filename} (${file.dimensions}) - ${this.formatBytes(
              file.size
            )}`
          );
        });
      });

    console.log("\n" + "=".repeat(60));
    console.log(`📊 SUMMARY:`);
    console.log(`   Orphaned files: ${this.orphanedFiles.length}`);
    console.log(`   Total size: ${this.formatBytes(this.totalSize)}`);

    if (isDryRun) {
      console.log(
        "\n💡 Run with --delete to actually remove these files (with backup)"
      );
    }
  }

  /**
   * Delete orphaned files with backup
   */
  async deleteWithBackup() {
    if (this.orphanedFiles.length === 0) {
      console.log("✅ No orphaned files to delete!");
      await this.logToCsv(
        "DELETE_OPERATION",
        "",
        0,
        "",
        "",
        "SUCCESS",
        "No orphaned files to delete"
      );
      return;
    }

    this.displayResults(false);

    console.log("\n📦 Creating backup before deletion...");
    if (this.deleteBackups) {
      console.log(
        "🗑️  --delete flag detected: backup directory will be cleaned up"
      );
    } else {
      console.log(
        "💾 Backup preservation: backup directory will be kept (default)"
      );
    }
    await this.createSimpleBackup();
    await this.logToCsv(
      "BACKUP_CREATED",
      this.backupPath,
      this.totalSize,
      "",
      "",
      "SUCCESS",
      `Backup created with ${this.orphanedFiles.length} files`
    );

    console.log("🗑️  Deleting orphaned files...");
    let deletedCount = 0;
    let failedCount = 0;

    for (const file of this.orphanedFiles) {
      try {
        await fs.unlink(file.path);
        deletedCount++;
        console.log(`   ✅ Deleted: ${file.relativePath}`);
        await this.logToCsv(
          "FILE_DELETED",
          file.path,
          file.size,
          file.dimensions,
          file.baseName,
          "SUCCESS",
          ""
        );
      } catch (error) {
        failedCount++;
        console.log(
          `   ❌ Failed to delete: ${file.relativePath} - ${error.message}`
        );
        await this.logToCsv(
          "FILE_DELETE_FAILED",
          file.path,
          file.size,
          file.dimensions,
          file.baseName,
          "ERROR",
          error.message
        );
      }
    }

    // Log summary
    await this.logToCsv(
      "DELETE_SUMMARY",
      "",
      this.totalSize,
      "",
      "",
      "SUCCESS",
      `${deletedCount} deleted, ${failedCount} failed`
    );

    console.log("\n" + "=".repeat(60));
    console.log("✅ CLEANUP COMPLETE!");
    console.log("=".repeat(60));
    console.log(`📊 Results:`);
    console.log(`   Files deleted: ${deletedCount}`);
    console.log(`   Failed deletions: ${failedCount}`);
    console.log(`   Space freed: ${this.formatBytes(this.totalSize)}`);
    console.log(`\n💾 Backup created: ${this.backupPath}`);
    if (!this.deleteBackups) {
      const tempDir = this.backupPath.replace(".zip", "-temp");
      console.log(`💾 Backup directory preserved: ${tempDir}`);
    }
    console.log(`📝 Log saved: ${this.logPath}`);
    console.log(
      `\n🔄 To restore files manually, extract: ${path.basename(
        this.backupPath
      )}`
    );

    // Add convenient restore command
    const backupFileName = path.basename(this.backupPath);
    console.log(`\n📋 To restore using this script, copy and paste:`);
    console.log(`   node app.js --restore ${backupFileName}`);
    console.log(`   node app.js --restore ${backupFileName} --delete`);
    console.log(`   (Use --delete to cleanup ZIP file after restore)`);
  }

  /**
   * Create backup zip file
   */
  async createSimpleBackup() {
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const tempDir = path.join(
      UPLOADS_PATH,
      `${BACKUP_PREFIX}-${timestamp}-temp`
    );
    const zipPath = path.join(
      UPLOADS_PATH,
      `${BACKUP_PREFIX}-${timestamp}.zip`
    );
    this.backupPath = zipPath;

    // Create temporary directory
    await fs.mkdir(tempDir, { recursive: true });

    // Create manifest
    const manifest = {
      created: new Date().toISOString(),
      totalFiles: this.orphanedFiles.length,
      totalSize: this.totalSize,
      files: this.orphanedFiles.map((f) => ({
        path: f.relativePath,
        size: f.size,
        baseName: f.baseName,
        dimensions: f.dimensions,
      })),
    };

    await fs.writeFile(
      path.join(tempDir, "manifest.json"),
      JSON.stringify(manifest, null, 2)
    );

    // Copy files maintaining directory structure
    for (const file of this.orphanedFiles) {
      const targetPath = path.join(tempDir, file.relativePath);
      const targetDir = path.dirname(targetPath);

      await fs.mkdir(targetDir, { recursive: true });
      await fs.copyFile(file.path, targetPath);
    }

    // Create ZIP file
    const archiver = require("archiver");
    const output = fsSync.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });

    return new Promise((resolve, reject) => {
      output.on("close", async () => {
        const zipSize = archive.pointer();
        // Keep temporary directory by default (delete only with --delete flag)
        if (!this.deleteBackups) {
          console.log(
            `   ✅ Backup ZIP created: ${this.formatBytes(
              zipSize
            )} - ${path.basename(zipPath)}`
          );
          console.log(`   💾 Backup directory preserved: ${tempDir}`);
          resolve();
        } else {
          try {
            await fs.rm(tempDir, { recursive: true });
            console.log(
              `   ✅ Backup ZIP created: ${this.formatBytes(
                zipSize
              )} - ${path.basename(zipPath)}`
            );
            resolve();
          } catch (error) {
            console.warn(
              `⚠️  Could not delete temporary directory: ${error.message}`
            );
            resolve(); // Still resolve since ZIP was created successfully
          }
        }
      });

      archive.on("error", reject);
      output.on("error", reject);

      archive.pipe(output);
      archive.directory(tempDir, false);
      archive.finalize();
    });
  }

  /**
   * Find the latest backup file by looking at log files
   */
  async findLatestBackup() {
    try {
      const logFiles = await fs.readdir(LOGS_DIR);
      const backupLogs = logFiles
        .filter(
          (file) => file.startsWith(BACKUP_PREFIX) && file.endsWith(".csv")
        )
        .sort()
        .reverse(); // Most recent first

      if (backupLogs.length === 0) {
        return null;
      }

      // Extract timestamp from log file name and construct ZIP file name
      const latestLog = backupLogs[0];
      const zipFileName = latestLog.replace(".csv", ".zip");

      // Check if the ZIP file actually exists
      const zipPath = path.join(UPLOADS_PATH, zipFileName);
      try {
        await fs.access(zipPath);
        return zipFileName;
      } catch (error) {
        console.warn(`⚠️  Log file found but ZIP file missing: ${zipFileName}`);
        return null;
      }
    } catch (error) {
      console.warn(`⚠️  Could not read logs directory: ${error.message}`);
      return null;
    }
  }

  /**
   * Restore files from backup ZIP
   */
  async restoreFromBackup(backupFileName) {
    if (!backupFileName) {
      throw new Error("Please specify a backup ZIP file name");
    }

    const backupPath = path.resolve(UPLOADS_PATH, backupFileName);

    try {
      await fs.access(backupPath);
    } catch (error) {
      throw new Error(`Backup ZIP file not found: ${backupPath}`);
    }

    console.log(`🔄 Restoring from backup ZIP: ${backupFileName}`);
    if (this.deleteBackups) {
      console.log(
        "🗑️  --delete flag detected: backup ZIP will be deleted after restore"
      );
    } else {
      console.log("💾 Backup ZIP will be preserved after restore (default)");
    }
    await this.logToCsv(
      "RESTORE_START",
      backupPath,
      0,
      "",
      "",
      "SUCCESS",
      `Restoring from: ${backupFileName}`
    );

    // Extract ZIP to temporary directory
    const extractPath = path.join(UPLOADS_PATH, `restore-temp-${Date.now()}`);
    await fs.mkdir(extractPath, { recursive: true });

    try {
      // Extract ZIP file
      const unzipper = require("unzipper");
      await new Promise((resolve, reject) => {
        fsSync
          .createReadStream(backupPath)
          .pipe(unzipper.Extract({ path: extractPath }))
          .on("close", resolve)
          .on("error", reject);
      });

      const manifestPath = path.join(extractPath, "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));

      let restoredCount = 0;

      for (const fileInfo of manifest.files) {
        const sourcePath = path.join(extractPath, fileInfo.path);
        const targetPath = path.join(UPLOADS_PATH, fileInfo.path);
        const targetDir = path.dirname(targetPath);

        try {
          await fs.mkdir(targetDir, { recursive: true });
          await fs.copyFile(sourcePath, targetPath);
          restoredCount++;
          console.log(`   ✅ Restored: ${fileInfo.path}`);
          await this.logToCsv(
            "FILE_RESTORED",
            targetPath,
            fileInfo.size,
            fileInfo.dimensions,
            fileInfo.baseName,
            "SUCCESS",
            ""
          );
        } catch (error) {
          console.log(
            `   ❌ Failed to restore: ${fileInfo.path} - ${error.message}`
          );
          await this.logToCsv(
            "FILE_RESTORE_FAILED",
            targetPath,
            fileInfo.size,
            fileInfo.dimensions,
            fileInfo.baseName,
            "ERROR",
            error.message
          );
        }
      }

      await this.logToCsv(
        "RESTORE_COMPLETE",
        "",
        0,
        "",
        "",
        "SUCCESS",
        `${restoredCount} files restored from ${backupFileName}`
      );
      console.log(`\n✅ Restore complete! ${restoredCount} files restored.`);
    } finally {
      // Clean up temporary extraction directory
      try {
        await fs.rm(extractPath, { recursive: true });
      } catch (error) {
        console.warn(
          `⚠️  Could not delete temporary extraction directory: ${error.message}`
        );
      }
    }

    // Conditionally delete backup ZIP file based on --delete flag
    if (!this.deleteBackups) {
      console.log(`💾 Backup ZIP preserved: ${backupFileName}`);
      await this.logToCsv(
        "BACKUP_PRESERVED",
        backupPath,
        0,
        "",
        "",
        "SUCCESS",
        `Backup ZIP preserved (default behavior)`
      );
    } else {
      try {
        await fs.unlink(backupPath);
        console.log(`🗑️  Backup ZIP deleted: ${backupFileName}`);
        await this.logToCsv(
          "BACKUP_DELETED",
          backupPath,
          0,
          "",
          "",
          "SUCCESS",
          `Backup ZIP deleted due to --delete flag`
        );
      } catch (error) {
        console.log(`⚠️  Could not delete backup ZIP: ${error.message}`);
        await this.logToCsv(
          "BACKUP_DELETE_FAILED",
          backupPath,
          0,
          "",
          "",
          "ERROR",
          error.message
        );
      }
    }
  }

  /**
   * Format bytes to human readable format
   */
  formatBytes(bytes) {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }
}

// Run the cleaner
async function main() {
  const cleaner = new OrphanedImageCleaner();
  await cleaner.run();
}

main().catch(console.error);

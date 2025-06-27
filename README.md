# WordPress Orphan Image Cleaner

A Node.js tool for identifying and cleaning up orphaned WordPress image size files (thumbnails without parent images) with backup and restore functionality.

## Features

- Scans WordPress uploads directory for orphaned image files
- Identifies size variants and parent files without originals
- Creates backup ZIP files before deletion
- Restore functionality from backup files
- Detailed CSV logging of all operations
- Dry-run mode for safe testing

## Usage

```bash
# Preview what would be deleted (recommended first step)
npm run scan

# Delete orphaned files with backup (keeps backup files by default)
npm run clean

# Delete orphaned files and cleanup backup files
npm run clean:delete

# Restore from latest backup (auto-detects)
npm run restore

# Restore and delete backup ZIP file
npm run restore:delete

# Manual restore from specific backup
node app.js --restore wp-oic-2024-01-15T10-30-00.zip
```

## Installation

```bash
npm install
```

## Requirements

- Node.js
- WordPress installation
- Read/write access to WordPress uploads directory

## File Patterns Detected

The tool identifies orphaned files based on these patterns:

### Size Variants

- Standard sizes: `image-300x200.jpg`
- Scaled sizes: `image-scaled-300x200.jpg`
- Edited sizes: `image-e1234567890-300x200.jpg`
- WebP copies: `image-300x200.jpg.webp`

### Parent Files

- Scaled parents: `image-scaled.jpg`
- Edited parents: `image-e1234567890.jpg`
- WebP parents: `image-scaled.jpg.webp`

## Safety Features

- Backup creation before any deletion
- Detailed logging to CSV files
- Dry-run mode for preview
- Restore capability from backups
- Only scans WordPress year/month folder structure

## Output

- Console progress and results
- CSV logs in `./logs/` directory
- Backup ZIP files in uploads directory

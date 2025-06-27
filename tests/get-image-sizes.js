#!/usr/bin/env node

/**
 * Node.js script to get custom image sizes registered in WordPress
 * via the REST API by analyzing media metadata
 */

const http = require("http");

// WordPress site URL
const SITE_URL = "http://destinationwilliamstown.local";

/**
 * Fetch media items and extract image sizes
 */
async function getCustomImageSizes() {
  return new Promise((resolve, reject) => {
    const mediaUrl = `${SITE_URL}/wp-json/wp/v2/media?per_page=50&media_type=image`;

    console.log(`Fetching media items from: ${mediaUrl}`);

    const request = http.get(mediaUrl, (response) => {
      let data = "";

      // Collect response data
      response.on("data", (chunk) => {
        data += chunk;
      });

      // Process complete response
      response.on("end", () => {
        try {
          const mediaItems = JSON.parse(data);

          if (!Array.isArray(mediaItems)) {
            console.error("Expected array of media items");
            reject(new Error("Invalid response format"));
            return;
          }

          console.log(`Found ${mediaItems.length} media items`);

          // Extract image sizes from media metadata
          const imageSizes = extractImageSizes(mediaItems);
          resolve(imageSizes);
        } catch (error) {
          console.error("Error parsing JSON response:", error.message);
          reject(error);
        }
      });
    });

    request.on("error", (error) => {
      console.error("Error making request:", error.message);
      reject(error);
    });

    request.setTimeout(10000, () => {
      console.error("Request timeout");
      request.destroy();
      reject(new Error("Request timeout"));
    });
  });
}

/**
 * Extract unique image sizes from media items
 */
function extractImageSizes(mediaItems) {
  const imageSizes = new Set();
  const sizeDetails = {};

  mediaItems.forEach((item, index) => {
    if (item.media_details && item.media_details.sizes) {
      const sizes = item.media_details.sizes;

      Object.keys(sizes).forEach((sizeName) => {
        imageSizes.add(sizeName);

        // Store details about this size (width, height)
        if (!sizeDetails[sizeName]) {
          sizeDetails[sizeName] = {
            name: sizeName,
            width: sizes[sizeName].width,
            height: sizes[sizeName].height,
            examples: [],
          };
        }

        // Add example file info
        if (sizeDetails[sizeName].examples.length < 3) {
          sizeDetails[sizeName].examples.push({
            file: sizes[sizeName].file,
            source_url: sizes[sizeName].source_url || "N/A",
          });
        }
      });
    }
  });

  return {
    uniqueSizes: Array.from(imageSizes).sort(),
    sizeDetails: sizeDetails,
    totalMediaItems: mediaItems.length,
  };
}

/**
 * Display the results in a nice format
 */
function displayResults(results) {
  console.log("\n" + "=".repeat(50));
  console.log("WORDPRESS IMAGE SIZES ANALYSIS");
  console.log("=".repeat(50));

  console.log(`\nAnalyzed ${results.totalMediaItems} media items`);
  console.log(`Found ${results.uniqueSizes.length} unique image sizes:\n`);

  // Display as simple array first
  console.log("Image Size Names:");
  console.log(JSON.stringify(results.uniqueSizes, null, 2));

  console.log("\n" + "-".repeat(50));
  console.log("DETAILED SIZE INFORMATION:");
  console.log("-".repeat(50));

  // Display detailed information for each size
  results.uniqueSizes.forEach((sizeName) => {
    const details = results.sizeDetails[sizeName];
    console.log(`\n📐 ${sizeName.toUpperCase()}`);
    console.log(`   Dimensions: ${details.width} × ${details.height}px`);

    if (details.examples.length > 0) {
      console.log(`   Example file: ${details.examples[0].file}`);
    }
  });

  console.log("\n" + "=".repeat(50));
  console.log("STANDARD VS CUSTOM SIZES:");
  console.log("=".repeat(50));

  // Identify standard WordPress sizes vs custom sizes
  const standardSizes = [
    "thumbnail",
    "medium",
    "medium_large",
    "large",
    "full",
  ];
  const customSizes = results.uniqueSizes.filter(
    (size) => !standardSizes.includes(size)
  );
  const foundStandardSizes = results.uniqueSizes.filter((size) =>
    standardSizes.includes(size)
  );

  console.log("\n📦 Standard WordPress sizes found:");
  console.log(
    foundStandardSizes.length > 0 ? foundStandardSizes : "None found"
  );

  console.log("\n🎨 Custom image sizes:");
  console.log(customSizes.length > 0 ? customSizes : "None found");

  return results.uniqueSizes;
}

// Run the script
console.log("WordPress Image Sizes Detector");
console.log("==============================");

getCustomImageSizes()
  .then(displayResults)
  .catch((error) => {
    console.error("Failed to get image sizes:", error.message);
    process.exit(1);
  });

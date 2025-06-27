#!/usr/bin/env node

/**
 * Node.js script to fetch WordPress version from destination-williamstown.local
 * via the WordPress REST API
 */

const https = require("https");
const http = require("http");

// WordPress site URL
const SITE_URL = "http://destinationwilliamstown.local";
const API_ENDPOINT = "/wp-json/";

/**
 * Fetch WordPress version from REST API
 */
async function getWordPressVersion() {
  return new Promise((resolve, reject) => {
    const url = `${SITE_URL}${API_ENDPOINT}`;

    console.log(`Fetching WordPress version from: ${url}`);

    // Use http since it's a local development site
    const request = http.get(url, (response) => {
      let data = "";

      // Collect response data
      response.on("data", (chunk) => {
        data += chunk;
      });

      // Process complete response
      response.on("end", () => {
        try {
          const jsonData = JSON.parse(data);

          if (jsonData.name && jsonData.description) {
            console.log("Site Name:", jsonData.name);
            console.log("Site Description:", jsonData.description);
            console.log("Site URL:", jsonData.url);
          }

          // WordPress version is typically in the namespaces or gmt_offset info
          if (jsonData.namespaces) {
            console.log("Available API Namespaces:", jsonData.namespaces);
          }

          // Try to get more detailed info from wp/v2 endpoint
          getDetailedSiteInfo();
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
 * Get more detailed site information
 */
function getDetailedSiteInfo() {
  const detailUrl = `${SITE_URL}/wp-json/wp/v2/`;

  console.log("\nFetching detailed site info...");

  const request = http.get(detailUrl, (response) => {
    let data = "";

    response.on("data", (chunk) => {
      data += chunk;
    });

    response.on("end", () => {
      try {
        const jsonData = JSON.parse(data);
        console.log("WordPress REST API v2 is available");

        // Try to get site info that might include version
        getSiteSettings();
      } catch (error) {
        console.error("Error parsing detailed info:", error.message);
      }
    });
  });

  request.on("error", (error) => {
    console.error("Error getting detailed info:", error.message);
  });
}

/**
 * Try to get site settings which may include version info
 */
function getSiteSettings() {
  // Note: This endpoint might require authentication
  const settingsUrl = `${SITE_URL}/wp-json/wp/v2/settings`;

  console.log("\nTrying to fetch site settings...");

  const request = http.get(settingsUrl, (response) => {
    let data = "";

    response.on("data", (chunk) => {
      data += chunk;
    });

    response.on("end", () => {
      if (response.statusCode === 401) {
        console.log("Settings endpoint requires authentication (expected)");
        console.log("\nTo get the exact WordPress version, you would need to:");
        console.log("1. Authenticate with the REST API, or");
        console.log("2. Check the site's HTML meta tags, or");
        console.log("3. Use wp-cli if available: wp core version");
        return;
      }

      try {
        const jsonData = JSON.parse(data);
        if (jsonData.title) {
          console.log("Site Title:", jsonData.title);
        }
      } catch (error) {
        console.log("Could not parse settings response");
      }
    });
  });

  request.on("error", (error) => {
    console.log("Settings endpoint not accessible (expected for public API)");
  });
}

// Run the script
console.log("WordPress Version Checker");
console.log("========================");

getWordPressVersion().catch((error) => {
  console.error("Failed to get WordPress version:", error.message);
  process.exit(1);
});

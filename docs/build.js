// Build helper: swap index.html to dev entry → vite build → copy dist output back
import { readFileSync, writeFileSync, cpSync } from "fs";
import { execSync } from "child_process";

const indexPath = "index.html";

// Step 1: Swap index.html to use source entry for Vite
let html = readFileSync(indexPath, "utf8");
const prodScript = html.match(/<script[^>]*src="[^"]*"[^>]*><\/script>/)?.[0];
html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, '<script type="module" src="/src/main.jsx"></script>');
writeFileSync(indexPath, html);
console.log("✅ index.html → dev entry");

// Step 2: Run vite build
try {
  execSync("npx vite build", { stdio: "inherit" });
} catch (e) {
  // Restore original on failure
  if (prodScript) {
    html = readFileSync(indexPath, "utf8");
    html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/, prodScript);
    writeFileSync(indexPath, html);
  }
  process.exit(1);
}

// Step 3: Copy dist output to docs root
cpSync("dist/assets", "assets", { recursive: true });
cpSync("dist/index.html", indexPath);
console.log("✅ dist → docs root copied");

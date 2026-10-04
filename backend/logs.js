// Cross-platform "tail -f" for the background server's log (Windows has no
// built-in tail). Shows what's already logged, then keeps printing new
// lines as they arrive. Press Ctrl+C to stop watching (the server itself
// keeps running).
const fs = require("fs");
const path = require("path");

const LOG_PATH = path.join(__dirname, "smartshelf.log");

if (!fs.existsSync(LOG_PATH)) {
  console.log("No log file yet — start the background server first with: npm run start:bg");
  process.exit(0);
}

let position = 0;
function printNew() {
  const { size } = fs.statSync(LOG_PATH);
  if (size < position) position = 0; // log was rotated/cleared
  if (size > position) {
    const stream = fs.createReadStream(LOG_PATH, { start: position, end: size - 1 });
    stream.on("data", (chunk) => process.stdout.write(chunk));
    position = size;
  }
}

printNew();
console.log(`\n(watching ${LOG_PATH} for new output — Ctrl+C to stop watching)\n`);
fs.watchFile(LOG_PATH, { interval: 500 }, printNew);

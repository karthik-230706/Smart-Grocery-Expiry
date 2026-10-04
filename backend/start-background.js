// Starts server.js (or tunnel.js, if passed as an argument) as a detached
// background process so it keeps running after you close this terminal
// window/tab — on Windows, Mac, and Linux.
// Run with: npm run start:bg   or   npm run tunnel:bg
// (stop either one later with: npm run stop)
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const TARGET = process.argv[2] || "server.js";
const LOG_PATH = path.join(__dirname, "smartshelf.log");
const PID_PATH = path.join(__dirname, "smartshelf.pid");

if (fs.existsSync(PID_PATH)) {
  const oldPid = parseInt(fs.readFileSync(PID_PATH, "utf8").trim(), 10);
  const stillRunning = (() => {
    try { process.kill(oldPid, 0); return true; } catch { return false; }
  })();
  if (stillRunning) {
    console.log(`SmartShelf already appears to be running in the background (PID ${oldPid}).`);
    console.log(`Run "npm run stop" first if you want to restart it (e.g. to switch between start:bg and tunnel:bg).`);
    process.exit(0);
  }
}

const out = fs.openSync(LOG_PATH, "a");
const err = fs.openSync(LOG_PATH, "a");

const child = spawn(process.execPath, [path.join(__dirname, TARGET)], {
  detached: true,
  stdio: ["ignore", out, err],
  windowsHide: true,
});
child.unref(); // let Node exit this launcher without waiting on / killing the child

fs.writeFileSync(PID_PATH, String(child.pid));

console.log(`\n✅ SmartShelf is now running in the background (PID ${child.pid}).`);
console.log(`   You can close this terminal — the server will keep running.`);
console.log(`   Its startup info (URLs + QR code) was written to: ${LOG_PATH}`);
console.log(`   To view it:  npm run logs`);
console.log(`   To stop it:  npm run stop\n`);

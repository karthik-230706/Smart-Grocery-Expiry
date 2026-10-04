// Stops the background server started by `npm run start:bg`.
const fs = require("fs");
const path = require("path");

const PID_PATH = path.join(__dirname, "smartshelf.pid");
const TUNNEL_PID_PATH = path.join(__dirname, "cloudflared.pid");

if (!fs.existsSync(PID_PATH)) {
  console.log("No background SmartShelf process is tracked (nothing to stop).");
  process.exit(0);
}

const pid = parseInt(fs.readFileSync(PID_PATH, "utf8").trim(), 10);
try {
  process.kill(pid);
  console.log(`Stopped SmartShelf (PID ${pid}).`);
} catch (err) {
  console.log(`Couldn't stop PID ${pid} (${err.message}) — it may already be stopped.`);
}
fs.unlinkSync(PID_PATH);

// If a Cloudflare tunnel child process was left running, stop that too.
if (fs.existsSync(TUNNEL_PID_PATH)) {
  const tunnelPid = parseInt(fs.readFileSync(TUNNEL_PID_PATH, "utf8").trim(), 10);
  try {
    process.kill(tunnelPid);
    console.log(`Stopped Cloudflare tunnel (PID ${tunnelPid}).`);
  } catch { /* already gone */ }
  fs.unlinkSync(TUNNEL_PID_PATH);
}

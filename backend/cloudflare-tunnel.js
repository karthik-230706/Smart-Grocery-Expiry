// Exposes the local server through a Cloudflare Tunnel public URL, reachable
// from ANY network — WiFi or mobile data — not just devices sharing the same
// WiFi as this computer. More stable than the localtunnel-based tunnel.js,
// and Cloudflare issues the HTTPS certificate for you (no browser warnings).
//
// Requires the free `cloudflared` command line tool to be installed once —
// see the install instructions this script prints if it can't find it.
//
// Run with: npm run tunnel:cf   or, to keep running after closing the
// terminal: npm run tunnel:cf:bg   (stop later with: npm run stop)

require("./server"); // starts the local HTTP(S) server + prints the usual LAN URLs

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = process.env.PORT || 4000;
const PID_PATH = path.join(__dirname, "cloudflared.pid");

let qrcode = null;
try { qrcode = require("qrcode-terminal"); } catch { /* optional — QR just won't print */ }

function printInstallHelp() {
  console.warn(`\n⚠️  Couldn't find "cloudflared" on this computer.`);
  console.warn(`   Install it once, then re-run this command:\n`);
  console.warn(`   Windows:  winget install --id Cloudflare.cloudflared`);
  console.warn(`   Mac:      brew install cloudflared`);
  console.warn(`   Linux:    see https://pkg.cloudflare.com/index.html\n`);
  console.warn(`   The LAN URLs printed above still work as long as the phone and PC share the same WiFi.\n`);
}

// Confirm the binary exists before trying to open a tunnel with it.
const check = spawnSync("cloudflared", ["--version"], { shell: process.platform === "win32" });
if (check.error || check.status !== 0) {
  printInstallHelp();
} else {
  const tunnel = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${PORT}`],
    { shell: process.platform === "win32" }
  );

  fs.writeFileSync(PID_PATH, String(tunnel.pid));

  let printed = false;
  const urlPattern = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/;

  const handleOutput = (data) => {
    const text = data.toString();
    const match = text.match(urlPattern);
    if (match && !printed) {
      printed = true;
      console.log(`\n🌍 Public URL — works on ANY network (WiFi or mobile data), from anywhere:`);
      console.log(`   ${match[0]}\n`);
      console.log(`   Cloudflare issues this URL's HTTPS certificate, so there's no browser`);
      console.log(`   security warning like with a self-signed certificate.\n`);
      if (qrcode) {
        console.log(`   Scan this to open it instantly:\n`);
        qrcode.generate(match[0], { small: true });
        console.log("");
      }
    }
  };

  tunnel.stdout.on("data", handleOutput);
  tunnel.stderr.on("data", handleOutput); // cloudflared logs its startup info to stderr

  tunnel.on("error", (err) => {
    console.warn(`\nCouldn't start cloudflared (${err.message}).`);
    printInstallHelp();
  });

  tunnel.on("exit", (code) => {
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
    console.log(`Cloudflare tunnel closed (code ${code}). Local server may still be running.`);
  });

  // If this script itself is stopped (e.g. via npm run stop's SIGTERM to the
  // parent), make sure the cloudflared child process doesn't get orphaned.
  const cleanup = () => { try { tunnel.kill(); } catch { /* already gone */ } };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("exit", cleanup);
}

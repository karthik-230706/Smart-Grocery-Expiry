// Exposes the local server through a public internet URL, so it's reachable
// from ANY network — WiFi or mobile data — not just devices sharing the same
// WiFi as this computer. Useful when the phone and PC can't reach each other
// directly: different networks, mobile data, or WiFi that blocks
// device-to-device traffic (common on campus/office/public WiFi).
// No account or signup needed.
require("./server"); // starts the local HTTP(S) server + prints the usual LAN URLs

const PORT = process.env.PORT || 4000;

let qrcode = null;
try { qrcode = require("qrcode-terminal"); } catch { /* optional — QR just won't print */ }

(async () => {
  let localtunnel;
  try {
    localtunnel = require("localtunnel");
  } catch {
    console.warn("\nCouldn't load the tunnel module — run \"npm install\" first, then try again.");
    return;
  }

  try {
    const tunnel = await localtunnel({ port: PORT });

    console.log(`\n🌍 Public URL — works on ANY network (WiFi or mobile data), from anywhere:`);
    console.log(`   ${tunnel.url}\n`);
    console.log(`   First open from a new device may show a plain "Friendly Reminder" page —`);
    console.log(`   that's normal for this free tunnel service, just click through it once.\n`);

    if (qrcode) {
      console.log(`   Scan this to open it instantly:\n`);
      qrcode.generate(tunnel.url, { small: true });
      console.log("");
    }

    tunnel.on("close", () => console.log("Public tunnel closed (local server may still be running)."));
    tunnel.on("error", (err) => console.warn("Tunnel error:", err.message));
  } catch (err) {
    console.warn(`\nCouldn't open a public tunnel (${err.message}).`);
    console.warn(`The LAN URLs printed above still work as long as the phone and PC share the same WiFi.`);
  }
})();

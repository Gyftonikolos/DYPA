const https = require("https");

function postJson(urlString, payload, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(String(urlString || ""));
    } catch (error) {
      reject(new Error("Invalid Discord webhook URL."));
      return;
    }

    const body = Buffer.from(JSON.stringify(payload), "utf8");
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search || ""}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": body.length
        },
        timeout: timeoutMs
      },
      (res) => {
        const status = res.statusCode || 0;
        const ok = status >= 200 && status < 300;
        res.resume();
        if (!ok) {
          reject(new Error(`Discord webhook responded with ${status}.`));
          return;
        }
        resolve(true);
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("Discord webhook request timed out."));
    });
    req.on("error", (error) => reject(error));
    req.write(body);
    req.end();
  });
}

async function sendDiscordWebhook(webhookUrl, { content }) {
  const message = String(content || "").trim();
  if (!webhookUrl || !message) {
    return false;
  }
  await postJson(webhookUrl, { content: message });
  return true;
}

module.exports = {
  sendDiscordWebhook
};


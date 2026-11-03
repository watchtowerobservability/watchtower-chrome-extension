import { init } from "@watchtowerobservability/chrome-extension";

const wt = init({ publishableKey: "wtp_replace_me", endpoint: "https://ingest.example.com", service: "my-extension" });

document.getElementById("go")!.addEventListener("click", () => {
  try {
    throw new Error("popup demo");
  } catch (e) {
    wt.captureError(e);
  }
});

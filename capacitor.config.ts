import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.gamersend.ompweb",
  appName: "omp web",
  webDir: "www",
  server: {
    url: "https://ompweb.b.red.mba",
    cleartext: false,
  },
};

export default config;

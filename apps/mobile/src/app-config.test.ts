// app.config.ts is outside src/ (Expo reads it at build time); its tests are here, where Jest looks.
import appConfig from "../app.config";

const configFor = (site: string) => {
  process.env.EXPO_PUBLIC_API_URL = site;
  return appConfig({ config: {}, projectRoot: "", staticConfigPath: null, packageJsonPath: null });
};
const original = process.env.EXPO_PUBLIC_API_URL;
afterEach(() => {
  process.env.EXPO_PUBLIC_API_URL = original;
});

describe("the app's links and passkeys", () => {
  it("belong to the site it talks to, when that's served over https", () => {
    const config = configFor("https://app.example.com");
    expect(config.ios?.associatedDomains).toEqual([
      "applinks:app.example.com",
      "webcredentials:app.example.com",
    ]);
    expect(config.android?.intentFilters).toEqual([
      {
        action: "VIEW",
        autoVerify: true,
        data: [{ scheme: "https", host: "app.example.com", pathPrefix: "/invitations/" }],
        category: ["BROWSABLE", "DEFAULT"],
      },
    ]);
  });

  it("aren't claimed for a development site, which iOS and Android can't verify", () => {
    const config = configFor("http://192.168.1.10:3000");
    expect(config.ios?.associatedDomains).toBeUndefined();
    expect(config.android?.intentFilters).toBeUndefined();
  });
});

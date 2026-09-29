describe("the API URL on a device", () => {
  const original = process.env.EXPO_PUBLIC_API_URL;
  afterEach(() => {
    process.env.EXPO_PUBLIC_API_URL = original;
  });

  const load = () => {
    let config: typeof import("./config") | undefined;
    jest.isolateModules(() => {
      config = require("./config");
    });
    return config as typeof import("./config");
  };

  it("comes from EXPO_PUBLIC_API_URL, without a trailing slash", () => {
    process.env.EXPO_PUBLIC_API_URL = "https://app.example.com/";
    expect(load().apiUrl).toBe("https://app.example.com");
  });

  it("is required, with a message saying what to set", () => {
    delete process.env.EXPO_PUBLIC_API_URL;
    expect(load).toThrow(/EXPO_PUBLIC_API_URL must be the site's URL/);
  });
});

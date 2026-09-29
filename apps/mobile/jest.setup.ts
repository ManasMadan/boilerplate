// Native modules that have no JavaScript fallback in tests.
jest.mock("expo-secure-store", () => ({
  getItem: jest.fn(),
  getItemAsync: jest.fn(async () => null),
  setItem: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
}));

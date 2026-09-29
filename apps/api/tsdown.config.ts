import { nodeService } from "@repo/tsdown-config";

// The service, plus the demo seed and the load-test users, which run the same modules.
export default nodeService({ entry: ["src/main.ts", "src/seed.ts", "src/load-users.ts"] });

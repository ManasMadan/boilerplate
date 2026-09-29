import { nodeService } from "@repo/tsdown-config";

// The service, and the demo seed (src/seed.ts), which runs the same modules.
export default nodeService({ entry: ["src/main.ts", "src/seed.ts"] });

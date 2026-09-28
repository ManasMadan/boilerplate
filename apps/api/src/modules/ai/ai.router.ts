import type { Procedures } from "../../rpc/procedures";
import type { AiService } from "./ai.service";

export const aiRouter = ({ inOrg }: Procedures, ai: AiService) => ({
  sentiment: inOrg.ai.sentiment.handler(({ input }) => ai.sentiment(input.text)),
});

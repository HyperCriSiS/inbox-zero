import { z } from "zod";

export const saveImapRuleFoldersBody = z.object({
  folders: z.array(z.string().min(1).max(1000)).max(100),
});

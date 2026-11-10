import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { getSieveServer } from "@/utils/sieve/sieve-server";

export type GetSieveServerResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("user/sieve", async (request) =>
  NextResponse.json(await getData(request.auth.emailAccountId)),
);

async function getData(emailAccountId: string) {
  const server = await getSieveServer(emailAccountId);
  return { available: !!server, name: server?.displayName ?? null };
}

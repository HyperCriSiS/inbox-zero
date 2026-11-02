-- CreateTable
CREATE TABLE "ImapConnection" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "emailAccountId" TEXT NOT NULL,
    "imapHost" TEXT NOT NULL,
    "imapPort" INTEGER NOT NULL,
    "imapSecurity" TEXT NOT NULL,
    "smtpHost" TEXT NOT NULL,
    "smtpPort" INTEGER NOT NULL,
    "smtpSecurity" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "tlsPinnedCertPem" TEXT,
    "capabilities" TEXT[],
    "labelStrategy" TEXT NOT NULL DEFAULT 'database',
    "labels" TEXT[],
    "syncLeaseOwner" TEXT,
    "syncLeaseUntil" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastSyncError" TEXT,
    "changesPrunedThrough" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "ImapConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImapMailbox" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "connectionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "role" TEXT,
    "uidValidity" BIGINT NOT NULL,
    "lastSeenUid" BIGINT NOT NULL DEFAULT 0,
    "highestModseq" BIGINT,

    CONSTRAINT "ImapMailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImapMessage" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "connectionId" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "uid" BIGINT NOT NULL,
    "threadId" TEXT NOT NULL,
    "rfc822MessageId" TEXT,
    "objectId" TEXT,
    "references" TEXT[],
    "labels" TEXT[],
    "flags" TEXT[],

    CONSTRAINT "ImapMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImapSyncItem" (
    "connectionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "ImapSyncItem_pkey" PRIMARY KEY ("connectionId","messageId")
);

-- CreateTable
CREATE TABLE "ImapChange" (
    "id" BIGSERIAL NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectionId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "ImapChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImapConnection_emailAccountId_key" ON "ImapConnection"("emailAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "ImapMailbox_connectionId_path_key" ON "ImapMailbox"("connectionId", "path");

-- CreateIndex
CREATE INDEX "ImapMessage_connectionId_threadId_idx" ON "ImapMessage"("connectionId", "threadId");

-- CreateIndex
CREATE INDEX "ImapMessage_connectionId_rfc822MessageId_idx" ON "ImapMessage"("connectionId", "rfc822MessageId");

-- CreateIndex
CREATE INDEX "ImapMessage_connectionId_objectId_idx" ON "ImapMessage"("connectionId", "objectId");

-- CreateIndex
CREATE INDEX "ImapMessage_references_idx" ON "ImapMessage" USING GIN ("references");

-- CreateIndex
CREATE UNIQUE INDEX "ImapMessage_mailboxId_uidValidity_uid_key" ON "ImapMessage"("mailboxId", "uidValidity", "uid");

-- CreateIndex
CREATE INDEX "ImapSyncItem_connectionId_processedAt_idx" ON "ImapSyncItem"("connectionId", "processedAt");

-- CreateIndex
CREATE INDEX "ImapChange_connectionId_id_idx" ON "ImapChange"("connectionId", "id");

-- AddForeignKey
ALTER TABLE "ImapConnection" ADD CONSTRAINT "ImapConnection_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapMailbox" ADD CONSTRAINT "ImapMailbox_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ImapConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapMessage" ADD CONSTRAINT "ImapMessage_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ImapConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapMessage" ADD CONSTRAINT "ImapMessage_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "ImapMailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapSyncItem" ADD CONSTRAINT "ImapSyncItem_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ImapConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImapChange" ADD CONSTRAINT "ImapChange_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "ImapConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;


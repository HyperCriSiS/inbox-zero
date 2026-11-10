-- AlterTable
ALTER TABLE "ImapConnection" ADD COLUMN     "ruleFolders" TEXT[] DEFAULT ARRAY[]::TEXT[];

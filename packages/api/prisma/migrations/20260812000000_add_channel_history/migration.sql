-- Audit des changements de canal stable/beta (traçabilité des bascules).
ALTER TABLE "SystemInfo" ADD COLUMN "channelHistory" JSONB NOT NULL DEFAULT '[]';
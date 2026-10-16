import { S3Client } from "@aws-sdk/client-s3";
import { getRequiredEnv } from "../config/env.js";

export function createR2Client(): S3Client {
  const accountId = getRequiredEnv("R2_ACCOUNT_ID");

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: getRequiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: getRequiredEnv("R2_SECRET_ACCESS_KEY"),
    },
  });
}

export function getR2BucketName(): string {
  return getRequiredEnv("R2_BUCKET_NAME");
}

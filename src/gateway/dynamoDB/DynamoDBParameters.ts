import { DynamoDBClientConfig } from "@aws-sdk/client-dynamodb";
import dotenv from "dotenv";

dotenv.config();

const dynamoDBRegion = "us-east-1";

let dynamoDBParameters: DynamoDBClientConfig = {
  region: dynamoDBRegion,
};

if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
  dynamoDBParameters.credentials = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  };
}

export default dynamoDBParameters;

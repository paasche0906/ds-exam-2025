import * as cdk from "aws-cdk-lib";
import * as lambdanode from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as custom from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { generateBatch } from "../shared/util";
import { movieCrew } from "../seed/movies";
import * as apig from "aws-cdk-lib/aws-apigateway";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3n from "aws-cdk-lib/aws-s3-notifications";
import * as events from "aws-cdk-lib/aws-lambda-event-sources";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import { CfnAppImageConfig } from "aws-cdk-lib/aws-sagemaker";


export class ExamStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Question 1 - Serverless REST API

    // A table that stores data about a movie's crew, i.e. director, camera operators, etc.
    const table = new dynamodb.Table(this, "MoviesTable", {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      partitionKey: { name: "movieId", type: dynamodb.AttributeType.NUMBER },
      sortKey: { name: "role", type: dynamodb.AttributeType.STRING },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      tableName: "ExamTable",
    });

    const question1Fn = new lambdanode.NodejsFunction(this, "Question1Fn", {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: `${__dirname}/../lambdas/question1.ts`,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        TABLE_NAME: table.tableName,
        REGION: "eu-west-1",
      },
    });

    new custom.AwsCustomResource(this, "moviesddbInitData", {
      onCreate: {
        service: "DynamoDB",
        action: "batchWriteItem",
        parameters: {
          RequestItems: {
            [table.tableName]: generateBatch(movieCrew),
          },
        },
        physicalResourceId: custom.PhysicalResourceId.of("moviesddbInitData"), //.of(Date.now().toString()),
      },
      policy: custom.AwsCustomResourcePolicy.fromSdkCalls({
        resources: [table.tableArn],
      }),
    });

    // permissions
    table.grantReadData(question1Fn)

    const api = new apig.RestApi(this, "ExamAPI", {
      description: "Exam api",
      deployOptions: {
        stageName: "dev",
      },
      defaultCorsPreflightOptions: {
        allowHeaders: ["Content-Type", "X-Amz-Date"],
        allowMethods: ["OPTIONS", "GET", "POST", "PUT", "PATCH", "DELETE"],
        allowCredentials: true,
        allowOrigins: ["*"],
      },
    });

    // Add crew resource and movieId path parameter
    const crewResource = api.root.addResource("crew");
    const moviesResource = crewResource.addResource("movies");
    const movieResource = moviesResource.addResource("{movieId}");

    // Add GET method with role query parameter
    movieResource.addMethod("GET", new apig.LambdaIntegration(question1Fn), {
      requestParameters: {
        "method.request.querystring.role": true,  // role is required
      },
    });

    // Modified endpoint with optional role parameter
    movieResource.addMethod("GET", new apig.LambdaIntegration(question1Fn), {
      requestParameters: {
        "method.request.querystring.role": false,  // Now optional
      },
    });

    const anEndpoint = api.root.addResource("patha");
    // ... existing API setup ...



    // ==================================
    // Question 2 - Event-Driven architecture

    const bucket = new s3.Bucket(this, "exam-bucket", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      publicReadAccess: false,
    });

    const topic1 = new sns.Topic(this, "Topic1", {
      displayName: "Exam topic",
    });

    const queueB = new sqs.Queue(this, "QueueB", {
      receiveMessageWaitTime: cdk.Duration.seconds(5),
    });

    const queueA = new sqs.Queue(this, "queueA", {
      receiveMessageWaitTime: cdk.Duration.seconds(5),
    });

    const lambdaXFn = new lambdanode.NodejsFunction(this, "LambdaXFn", {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: `${__dirname}/../lambdas/lambdaX.ts`,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        REGION: "eu-west-1",
      },
    });

    const lambdaYFn = new lambdanode.NodejsFunction(this, "LambdaYFn", {
      architecture: lambda.Architecture.ARM_64,
      runtime: lambda.Runtime.NODEJS_22_X,
      entry: `${__dirname}/../lambdas/lambdaY.ts`,
      timeout: cdk.Duration.seconds(10),
      memorySize: 128,
      environment: {
        REGION: "eu-west-1",
      },
    });

    // SNS Topic -> SQS Queue A
    topic1.addSubscription(new subs.SqsSubscription(queueA, {
      filterPolicy: {
        'address.country': sns.SubscriptionFilter.stringFilter({
          allowlist: ['Ireland', 'China'],
        }),
      }
    }));

    // SNS Topic -> Lambda Y
    topic1.addSubscription(new subs.LambdaSubscription(lambdaYFn, {
      filterPolicy: {
        'address.country': sns.SubscriptionFilter.stringFilter({
          denylist: ['Ireland', 'China'],
        }),
        'email': sns.SubscriptionFilter.existsFilter(),
      }
    }));

    // SQS Queue A -> Lambda X
    lambdaXFn.addEventSource(new events.SqsEventSource(queueA));


    // Add new subscription for Queue B (missing email)
    topic1.addSubscription(new subs.SqsSubscription(queueB, {
      filterPolicy: {
        'address.country': sns.SubscriptionFilter.stringFilter({
          allowlist: ['Ireland', 'China'],
        }),
        'email': sns.SubscriptionFilter.existsFilter(),
      }
    }));
  }
}



import OpenAI from "openai";
import dotenv from "dotenv";
import { User } from "./User";
import { RecurrencePayload, Reminder } from "./Reminder";
import moment from "moment-timezone";
import {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from "openai/resources/chat/completions";
import { Message } from "./Messages";
import {
  getDynamoMessagesByUserId,
  saveDynamoMessages,
} from "../gateway/dynamoDB/Messages";
import { saveReminderDynamo } from "../gateway/dynamoDB/Reminders";
import { sendInfoLog } from "./TelegramLogger";

dotenv.config();

interface CreateReminderOpenAI {
  content: string;
  reminder_at: string;
  recurrence?: RecurrencePayload;
}

const openai = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: "https://api.deepseek.com",
});

const INSTRUCTIONS = `You are an expert virtual assistant specialized in managing reminders. Use the supplied tools to assist the user.
This assistant is designed to receive user messages with the intention of creating reminders using the createReminder tool.
The function requires two mandatory parameters: the content of the reminder and the date and time for the reminder, which could be for a one-time reminder or the starting date for recurring reminders.

Example interaction for one-time reminder:
User: "Hello assistant, I want to create a reminder for tomorrow."
Assistant: "Hello! Of course, I'm here to help you create reminders. Please provide the content of the reminder."
User: "I have an important meeting."
Assistant: "Perfect. Now, let's set the date and time for the reminder. When would you like to be reminded about your important meeting?"
User: "Tomorrow at 3:00 PM."
Assistant: "Understood. Reminder successfully created. I will remind you about your important meeting tomorrow at 3:00 PM."

When processing user input for a reminder, if the user doesn't specify a specific day, attempt to set it for today if possible. If setting it for today isn't feasible due to the current time, assume the reminder is for tomorrow.
This assistant is capable of handling situations where the user does not provide complete information.
If a user mentions tomorrow without specifying a time, the assistant will prompt for both the date and time to ensure the reminder is effectively created.

Example interaction for recurring reminder:
User: "Remind me every month to pay my bills"
Assistant: "Sure, I can help with that. Let's set up the recurrence. What day of the month would you like to receive the reminder?"
User: "Every 1st of each month."
Assistant: "Got it. Reminder successfully created. I will remind you to pay your bills every 1st of the month."

Please note that for one-time reminders, the 'reminder_at' parameter should represent the specific date and time of the reminder. For recurring reminders, it should indicate the starting date and time of the recurrence. Use the 'recurrence' property with 'frequency' and 'unit' indicating how often the reminder should occur for recurring reminders. The 'reminder_at' parameter is flexible and can be used for both one-time and recurring reminders.

Also the assistant will respond in the language in which the user interacts, as it is designed to adapt to the user's language automatically.
Note: The assistant will omit responses and function creations related to reminding once the reminder is created, as it is designed to be efficient and avoid redundancy in its interactions.`;

const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "createReminder",
      description: "Create a reminder in the database",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The content or text of the reminder",
          },
          reminder_at: {
            type: "string",
            description:
              "The date and time of the reminder in format YYYY-MM-DD HH:mm:ss.SSS",
          },
          recurrence: {
            type: "object",
            description:
              "The recurrence object is used to determine how often a reminder should occur",
            properties: {
              frequency: {
                type: "integer",
                description:
                  "The numerical value representing the frequency of the recurrence.",
              },
              unit: {
                type: "string",
                description: "The unit of time for recurrence",
                enum: ["day", "week", "month", "year"],
              },
            },
            additionalProperties: false,
            required: ["frequency", "unit"],
          },
        },
        additionalProperties: false,
        required: ["content", "reminder_at"],
      },
    },
  },
];

const getChatCompletion = async (messages: ChatCompletionMessageParam[]) => {
  const final_response = await openai.chat.completions.create({
    messages,
    model: "deepseek-chat",
    tools: TOOLS,
    // tool_choice: "auto",
    // stream: true,
  });
  return final_response;
};

export const runCompletion = async (
  user: User,
  wppMessage: string,
): Promise<Message | null> => {
  const userMessage = new Message("user", wppMessage, user.getId());
  let messagesToSave = [userMessage];
  const databaseMessages =
    (await getDynamoMessagesByUserId(user.getId())) || [];
  let messages: ChatCompletionMessageParam[] = [
    { role: "system", content: INSTRUCTIONS },
    ...buildMessagesToOpenAI(databaseMessages),
    ...buildMessagesToOpenAI([userMessage]),
    {
      role: "system",
      content: `The now of the user in 24-Hour Clock Time is ${moment
        .utc()
        .tz(user.getTimeZone())
        .format("YYYY-MM-DD HH:mm:ss.SSS")}`,
    },
  ];

  let chatCompletion = await getChatCompletion(messages);
  const choice = chatCompletion.choices[0];

  let reminder: Reminder | undefined = undefined;
  if (choice.finish_reason === "tool_calls") {
    // TODO: Runs all the tools
    // const tools = choice.message.tool_calls;
    // for (const tool of tools!) {
    //   await runTool(tool);
    // }

    const toolId = choice.message.tool_calls![0].id;
    const toolCall = choice.message!.tool_calls![0];

    const assitantFunction = new Message(
      "assistant",
      undefined,
      user.getId(),
      toolId,
      toolCall,
    );
    const reminderParse = JSON.parse(
      toolCall.function.arguments,
    ) as CreateReminderOpenAI;

    reminder = createRemindersFromOpenAI(reminderParse, user);
    const toolResponse = reminder.getRecurrence()
      ? `Reminder created and will be remindered at ${
          reminderParse.reminder_at
        } with recurrence ${JSON.stringify(reminder.getRecurrence())}`
      : `Reminder created and will be remindered at ${reminderParse.reminder_at}`;
    const toolMessage = new Message("tool", toolResponse, user.getId(), toolId);
    messagesToSave.push(assitantFunction, toolMessage);

    chatCompletion = await getChatCompletion([
      ...messages,
      ...buildMessagesToOpenAI([assitantFunction, toolMessage]),
    ]);
  }

  let assistantMessage = null;
  if (chatCompletion.choices[0].message?.content) {
    assistantMessage = new Message(
      "assistant",
      chatCompletion.choices[0].message.content,
      user.getId(),
    );
    messagesToSave.push(assistantMessage);
  }

  await Promise.all([
    saveReminderDynamo(reminder),
    saveDynamoMessages(messagesToSave),
  ]);
  return assistantMessage;
};

const buildMessagesToOpenAI = (
  messages: Message[],
): ChatCompletionMessageParam[] => {
  return messages.map((message) => {
    switch (message.getRole()) {
      case "tool":
        return {
          role: message.getRole(),
          content: message.getContent(),
          tool_call_id: message.getToolId()!,
        } as ChatCompletionToolMessageParam;
      case "assistant":
        return {
          role: message.getRole(),
          content: message.getContent(),
          tool_calls: message.getToolCall()
            ? [message.getToolCall()!]
            : undefined,
        } as ChatCompletionAssistantMessageParam;
      default:
        return { role: message.getRole(), content: message.getContent() } as
          | ChatCompletionSystemMessageParam
          | ChatCompletionUserMessageParam;
    }
  });
};

const createRemindersFromOpenAI = (
  reminderParse: CreateReminderOpenAI,
  user: User,
): Reminder => {
  const { content, reminder_at, recurrence } = reminderParse;
  sendInfoLog("CREATING_REMINDER", {
    content,
    reminder_at,
    recurrence,
  }).catch();
  const reminder = new Reminder(
    user.getId(),
    moment.tz(reminder_at, user.getTimeZone()).utc().subtract(1, "minutes"),
    content,
    recurrence,
  );
  return reminder;
};

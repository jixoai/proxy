// Please install OpenAI SDK first: `npm install openai`

import { parseArgs } from "node:util";
import OpenAI from "openai";

async function main() {
  const completion = await openai.chat.completions.create({
    messages: [{ role: "system", content: "You are a helpful assistant." }],
    model: "deepseek-chat",
  });

  console.log(completion.choices[0]!.message.content);
}

async function stream() {
  // const stream = await openai.responses.create({
  //   model: "deepseek-chat",
  //   input: [
  //     {
  //       role: "user",
  //       content: "Say 'double bubble bath' ten times fast.",
  //     },
  //   ],
  //   stream: true,
  // });

  // for await (const event of stream) {
  //   console.log(event);
  // }
  const completion = await openai.chat.completions.create({
    messages: [{ role: "system", content: "You are a helpful assistant." }],
    model: "deepseek-chat",
    stream: true,
  });

  for await (const event of completion) {
    process.stdout.write(event.choices[0]!.delta.content!);
  }
}

const args = parseArgs({
  args: process.argv,
  strict: false,
  options: {
    local: {
      type: "boolean",
      default: false,
    },
    stream: {
      type: "boolean",
      default: false,
    },
  },
}).values;

const openai = new OpenAI({
  baseURL: args.local ? "http://localhost:10001" : "https://gaubee.tweb.xin",
  apiKey: "-",
});

if (args.stream) {
  stream();
} else {
  main();
}

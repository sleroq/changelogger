import { Bot } from "https://deno.land/x/grammy@v1.18.1/mod.ts";
import { OpenAI } from "https://deno.land/x/openai@1.4.2/mod.ts";
import { Message, getEnv, loadMemory, saveMemory } from "./helpers.ts";

interface BotConfig {
  token: string;
  openAIKey: string;
  model: string;
  defaultPrompt: string;
  temperature: number;
  maxTokens: number;
  whitelist: number[];
}

const config: BotConfig = {
  token: getEnv("BOT_TOKEN"),
  openAIKey: getEnv("OPENAI_API_KEY"),
  model: getEnv("OPENAI_MODEL"),
  defaultPrompt: getEnv("OPENAI_PROMPT").trim(),
  temperature: parseFloat(getEnv("OPENAI_TEMPERATURE", "1")),
  maxTokens: parseInt(getEnv("OPENAI_MAX_TOKENS", "2000")),
  whitelist: getEnv("BOT_WHITELIST", "").split(',').map((id) => parseInt(id)),
};

const bot = new Bot(config.token);
const openAI = new OpenAI(config.openAIKey);

const openAIPrompt = async (message: string, prompt: string) => {
  const completion = await openAI.createChatCompletion({
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    topP: 1,
    messages: [
      {
        content: "You are ChatGPT, a large language model trained by OpenAI.\nCarefully heed the user's instructions.\nRespond using Markdown.",
        role: "system",
      },
      {
        content: prompt,
        role: "user",
      },
      {
        content: message,
        role: "user",
      }
    ],
  });

  if (completion.choices.length === 0) {
    throw new Error('No completion choices');
  }

  if (completion.choices[0].message.content === null) {
    throw new Error('Completion choice content is null');
  }

  return completion.choices[0].message.content.trim();
}

const memory = await loadMemory();

bot.catch((err) => {
  console.error(err);
});

bot.on('message', async (ctx, next) => {
  if (ctx.msg.text === '/json') {
    await next();
    return;
  }

  if (!config.whitelist.includes(ctx.chat.id)) {
    await ctx.reply('This bot is not available in this chat');
    await ctx.reply('If you want to use this bot in your chat, contact @sleroq');
    return;
  }

  await next();
});

const helpMessage = `Commands:\n` +
  `/s [limit] - Generate a message based on one or more previous messages\n` +
  `/sp - Set custom prompt\n` +
  `/rp - Remove custom prompt\n
  /json - Get info about message`;

bot.command('start', async (ctx) => {
  await ctx.reply(helpMessage);
});

bot.command('help', async (ctx) => {
  await ctx.reply(helpMessage);
  await ctx.reply(`Current prompt: ${memory[ctx.chat.id].prompt || config.defaultPrompt}`);
});

bot.on('message', async (ctx, next) => {
  if (!memory[ctx.chat.id]) {
    memory[ctx.chat.id] = {
      messages: {},
    };
  }

  let source = undefined;
  if (ctx.msg.forward_from_chat && ctx.msg.forward_from_chat.id < 0) {
    const chat = Math.abs(ctx.msg.forward_from_chat.id + 1000000000000);
    source = `https://t.me/c/${chat}/${ctx.msg.forward_from_message_id}`
  }

  memory[ctx.chat.id].messages[ctx.msg.message_id] = {
    text: ctx.msg.text || ctx.msg.caption,
    forward: ctx.msg.forward_date !== undefined,
    forwardUrl: source,
    user: {
      id: ctx.from.id,
      username: ctx.from.username,
    },
  };

  await saveMemory(memory);

  await next();
});

async function getReply(message: string, prompt: string, source?: string) {
  let response = '';
  try {
    response = await openAIPrompt(message, prompt);
  } catch (error) {
    console.error(error);
    response = 'Error generating reply:\n\n' + error.message;
  }

  console.log(source)
  if (source) {
    response = response
      .replaceAll(/\]\s*\(https:\/\/.+\)/g, `](${source})`)
      .replaceAll(/\]\s*\(source\)/gi, `](${source})`)
  }

  response = response.replaceAll('_', '\\_')

  return response;
}

bot.command('s', async (ctx) => {
  await ctx.api.sendChatAction(ctx.chat.id, 'typing');
  const prompt = memory[ctx.chat.id].prompt || config.defaultPrompt;

  if (!ctx.msg.reply_to_message || !ctx.msg.reply_to_message.message_id) {
    const messages = memory[ctx.chat.id].messages;
    let previousMessage = messages[ctx.msg.message_id - 1];

    let noMessageCount = 0;
    for (let i = 1; i < 1000; i++) {
      if (noMessageCount > 2) {
        await ctx.reply('No anwer for you, silly');
        return;
      }

      if (!previousMessage) {
        previousMessage = messages[ctx.msg.message_id - i];
        noMessageCount++;
        continue;
      }

      noMessageCount = 0;

      if (!previousMessage.text) {
        previousMessage = messages[ctx.msg.message_id - i];
        continue
      }


      if (!previousMessage.forward) {
        previousMessage = messages[ctx.msg.message_id - i];
        continue
      }

      break;
    }

    if (!previousMessage.text) {
      await ctx.reply('No anwer for you, dummy');
      return;
    }

    const gptReply = await getReply(previousMessage.text, prompt, previousMessage.forwardUrl);
    try {
      await ctx.reply(gptReply, { parse_mode: 'Markdown' });
    } catch (error) {
      console.error(error);

      // try again without markdown
      await ctx.reply(gptReply);
    }

    return
  }

  const parameters = ctx.msg.text.split(' ');
  let limit = parseInt(parameters[1]) || 1;

  const history = memory[ctx.chat.id].messages;

  const originalMsgId = ctx.msg.reply_to_message.message_id;
  let messages: Message[] = [];
  for (let i = originalMsgId; i < originalMsgId + limit; i++) {
    const msg = history[i];
    if (msg && msg.text && msg.forward) {
      messages.push(msg);
    } else if (msg && !msg.text) {
      limit++;
    }
  }

  messages = messages.map((msg) => {
    return {
      ...msg,
      text: msg.text?.replaceAll('\n\n', '\n'),
    };
  });

  // limit to 700 symbols for multiple messages
  if (messages.length > 1) {
    messages = messages.map((msg) => {
      return {
        ...msg,
        text: msg.text?.substring(0, 677) + '...',
      };
    });
  }

  let response = '';
  for (const msg of messages) {
    await ctx.api.sendChatAction(ctx.chat.id, 'typing');

    if (!msg.text) {
      continue;
    }

    const gptReply = await getReply(msg.text, prompt, msg.forwardUrl);
    response += gptReply + '\n\n';
  }

  try {
    await ctx.reply(response, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error(error);

    // try again without markdown
    await ctx.reply(response);
  }
});

bot.command('sp', async (ctx) => {
  const reply = ctx.msg.reply_to_message
  if (!reply) {
    await ctx.reply('You must reply to a message to use this command');
    return;
  }

  const prompt = reply.text;
  if (!prompt) {
    await ctx.reply('The replied message must contain text');
    return;
  }

  memory[ctx.chat.id].prompt = prompt;
  await saveMemory(memory);
  await ctx.reply('Prompt set');
});

bot.command('rp', async (ctx) => {
  memory[ctx.chat.id].prompt = undefined;

  await saveMemory(memory);
  await ctx.reply('Prompt removed');
});

bot.command('json', async (ctx) => {
  if (!ctx.from) {
    await ctx.reply('Who are you?');
    return;
  }

  const reply = ctx.msg.reply_to_message

  if (!reply) {
    await ctx.reply(`Your user ID is ${ctx.from.id}\nChat ID: ${ctx.chat.id}`);
  } else {
    await ctx.reply(JSON.stringify(reply, null, 2));
  }
});

bot.start();

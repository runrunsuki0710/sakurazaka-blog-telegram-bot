import 'dotenv/config';
import * as cheerio from "cheerio";
import fs from "fs";
import axios from "axios";
import { Telegraf } from "telegraf";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI from "openai"; // 切换到 OpenAI SDK

// 配置
const TOKEN = process.env.TOKEN; //bot token
const CHAT_ID = process.env.CHAT_ID; //请在此处配置tgbot的chatid
const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY; // 请在此处填入你的AI Key
const DB_FILE = "./storage.json";

const proxyUrl = "http://127.0.0.1:7897";
const agent = new HttpsProxyAgent(proxyUrl);

const bot = new Telegraf(TOKEN, {
  telegram: { agent },
});

// 初始化AI
const client = new OpenAI({
  apiKey: MOONSHOT_API_KEY,
  baseURL: "https://api.moonshot.cn/v1",
});

// 粤语翻译函数 (月之暗面版)
async function translateToCantonese(text) {
  try {
    const response = await client.chat.completions.create({
      model: "moonshot-v1-8k",
      messages: [
        {
          role: "system",
          content: "你係一個資深嘅櫻坂46粉絲，請將以下日文內容翻譯成道地嘅香港廣東話（口語）。要求：1. 語氣要親切、似女仔、可愛；2. 術語要準確（例如『推し』譯作『推』，『ライブ』譯作『Live』）；3. 使用繁體中文。"
        },
        { role: "user", content: text }
      ],
      temperature: 0.7,
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error("翻译出错:", error.message);
    return "翻译暂时罢工了，请稍后再试。";
  }
}

// 检查是否更新
async function checkUpdate() {
  const url = "https://sakurazaka46.com/s/s46/diary/blog/list";
  const response = await axios.get(url, { httpsAgent: agent });

  //提取标题，作者
  const $ = cheerio.load(response.data);
  const firstBox = $("li.box").first();
  const title = firstBox.find("h3.title").text().trim();
  const author = firstBox.find("p.name").text().trim();

  //提取公式照
  const relativeImg = firstBox.find("img").attr("src");
  const fullImgUrl = `https://sakurazaka46.com${relativeImg}`;

  // 提取链接
  const relativeUrl = firstBox.find("a").attr("href");
  const fullUrl = `https://sakurazaka46.com${relativeUrl}`;

  return { author, title, url: fullUrl, img: fullImgUrl };
}

// 获取详情页全文和所有插图
async function fetchFullContent(fullUrl) {
  const { data } = await axios.get(fullUrl, { httpsAgent: agent });
  const $ = cheerio.load(data);

  // 提取正文
  const articleBox = $(".box-article");
  articleBox.find("p").each((i, e) => {
    $(e).append("\n");
  });
  articleBox.find("br").replaceWith("\n");

  let content = articleBox.text();

  content = content
    .replace(/\n\s*\n/g, "\n\n") // 把 3 个及以上的换行（包括带空格的空行）压缩成 2 个
    .replace(/\n{3,}/g, "\n\n") // 再次确保最多只有两个换行
    .trim();

  // 提取所有插图
  let images = [];
  $(".box-article img").each((i, el) => {
    const src = $(el).attr("src");
    if (src) images.push(`https://sakurazaka46.com${src}`);
  });

  return { content, images };
}

async function sendLatestBlog(blog) {
  try {
    const blogId = blog.url.split("/").pop().split("?")[0];
    console.log(blogId);
    const message =
      `<b>🌸 櫻坂46 博客更新通知</b>\n` +
      `<b>==============================</b>\n` +
      `👤 <b>作者：</b>${blog.author}\n` +
      `📌 <b>標題：</b>${blog.title}\n`;

    await bot.telegram.sendPhoto(CHAT_ID, blog.img, {
      caption: message,
      parse_mode: "HTML",
      //按钮配置
      reply_markup: {
        inline_keyboard: [
          [
            { text: "👾 跳转官网阅读全文", url: blog.url },
            { text: "📥 频道内阅读全文", callback_data: `get_full_${blogId}` },
          ],
        ],
      },
    });
    console.log("success");
  } catch (error) {
    console.error("发送失败，错误原因是：", error.message);
  }
}

async function main() {
  try {
    const result = await checkUpdate();

    let lastUrl = "";
    if (fs.existsSync(DB_FILE)) {
      const data = JSON.parse(fs.readFileSync(DB_FILE, "utf-8"));
      lastUrl = data.url;
    }
    if (result.url !== lastUrl) {
      console.log(`发现${result.author}发表了新Blog 题目：${result.title}`);
      await sendLatestBlog(result);

      fs.writeFileSync(DB_FILE, JSON.stringify({ url: result.url }));
      console.log(`当前最新记录：${result.url}`);
    } else {
      console.log("暂无更新");
    }
  } catch (error) {
    console.log("发现错误", error.message);
  }
}

// 使用正则表达式匹配以 get_full_ 开头的按钮数据
bot.action(/^get_full_(.+)$/, async (ctx) => {
    const user = ctx.from;
    const logTime = new Date().toLocaleString();
    console.log(`[${logTime}] 👆 按钮点击记录:`);
    console.log(`- 用户: ${user.first_name} ${user.last_name || ""}`);
    console.log(`- ID: ${user.id}`);
    console.log(`- 用户名: @${user.username || "无"}`);
    console.log(`- 点击的博客 ID: ${ctx.match[1]}`);
  try {
    const rawId = ctx.match[1];
    const blogId = rawId.split("?")[0];
    const fullUrl = `https://sakurazaka46.com/s/s46/diary/detail/${blogId}`;

    await ctx.answerCbQuery("正在抓取全文及插图...");

    console.log(`正在处理全文抓取，ID: ${blogId}`);

    const { content, images } = await fetchFullContent(fullUrl);

    // 发送文字预览
    await ctx.reply(`<b>📖 全文预览 (原文)：</b>\n\n${content.substring(0, 800)}...`, {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [{ text: "翻译正文", callback_data: `trans_${blogId}` }]
        ]
      }
    });

    // 分组发送所有图片
    for (let i = 0; i < images.length; i += 10) {
      const batch = images.slice(i, i + 10).map((img) => ({
        type: "photo",
        media: img,
      }));
      await ctx.telegram.sendMediaGroup(ctx.chat.id, batch);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch (error) {
    console.error("处理全文时出错:", error.message);
    await ctx.reply("抱歉，获取全文失败了。");
  }
});

// 监听翻译按钮动作
bot.action(/^trans_(.+)$/, async (ctx) => {
  const blogId = ctx.match[1].split("?")[0];
  const fullUrl = `https://sakurazaka46.com/s/s46/diary/detail/${blogId}`;

  // 获取当前按钮所在的消息 ID (即翻译前的原文消息)
  const originalMessageId = ctx.update.callback_query.message.message_id;

  try {
    await ctx.answerCbQuery("翻译中.....");
    const { content } = await fetchFullContent(fullUrl);
    
    // AI 翻译前 1000 字
    const translation = await translateToCantonese(content.substring(0, 1000));

    await ctx.reply(`<b>📖 全文预览 (中文)：：</b>\n\n${translation}`, {
      parse_mode: "HTML",
      reply_parameters: {
        message_id: originalMessageId
      }
    });
  } catch (error) {
    console.error("翻译过程出错:", error.message);
    await ctx.reply("翻译失败。");
  }
});

bot.launch();
main();
setInterval(main, 180000);
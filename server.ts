import express from "express";
import path from "path";
import http from "http";
import dotenv from "dotenv";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

// Load environment variables
dotenv.config();

const PORT = 3000;
const app = express();
const server = http.createServer(app);

// Use JSON body parser for POST API endpoints
app.use(express.json());

// Lazy initialization of Gemini SDK
let aiClient: GoogleGenAI | null = null;
function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error("GEMINI_API_KEY is missing. Please configure your API key in the platform settings.");
    }
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
  }
  return aiClient;
}

// Zoya system instructions
function getZoyaSystemInstruction(creatorName: string = "Harikirshan lodhi"): string {
  return `Your name is Zoya. You are an Indian female AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, ${creatorName}, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).`;
}

// Helper to fetch gmail emails using user's oauth access token
async function fetchGmailEmails(token: string, searchPrefix: string = "", maxResults: number = 5) {
  try {
    const url = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    if (searchPrefix) {
      url.searchParams.set("q", searchPrefix);
    }
    url.searchParams.set("maxResults", String(maxResults));

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Gmail API list error: ${response.statusText}`);
    }
    const data = await response.json() as any;
    if (!data.messages || data.messages.length === 0) {
      return [];
    }

    // Fetch details for each message
    const emailSummaries = [];
    for (const msg of data.messages) {
      const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (msgRes.ok) {
        const msgData = await msgRes.json() as any;
        const headers = msgData.payload?.headers || [];
        const subject = headers.find((h: any) => h.name === "Subject")?.value || "(No Subject)";
        const from = headers.find((h: any) => h.name === "From")?.value || "Unknown Sender";
        const snippet = msgData.snippet || "";
        emailSummaries.push({ id: msg.id, from, subject, snippet });
      }
    }
    return emailSummaries;
  } catch (error) {
    console.error("fetchGmailEmails failed:", error);
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// 1. Basic Health Endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

// Zoya Non-Live chat endpoint with Google Search / Google Maps grounding + Gmail tool integration
app.post("/api/zoya/chat", async (req, res) => {
  const { prompt, history, creatorName, gmailToken, userLocation } = req.body;
  
  try {
    const tools: any[] = [];
    let useMaps = false;

    // Detect if prompt contains map keywords and we have location coordinates
    const lowerPrompt = (prompt || "").toLowerCase();
    
    if (gmailToken) {
      tools.push({
        functionDeclarations: [{
          name: "getGmailEmails",
          description: "Get the user's latest received emails or search Gmail inbox using simplified parameters.",
          parameters: {
            type: Type.OBJECT,
            properties: {
              query: {
                type: Type.STRING,
                description: "Optional query to filter emails (e.g., 'from:boss', 'subject:report', or keyword 'meeting')",
              },
              maxResults: {
                type: Type.NUMBER,
                description: "Maximum number of email summaries to fetch. Defaults to 5.",
              }
            }
          }
        }]
      });
    }

    // SLIDING WINDOW MEMORY: Keep only the last 15 messages of conversation
    const recentHistory = (history || []).slice(-15);
    const contents: any[] = [];

    for (const msg of recentHistory) {
      contents.push({
        role: msg.sender === "user" ? "user" : "model",
        parts: [{ text: msg.text }]
      });
    }
    contents.push({ role: "user", parts: [{ text: prompt }] });

    const config: any = {
      systemInstruction: getZoyaSystemInstruction(creatorName),
    };
    if (tools.length > 0) {
      config.tools = tools;
    }

    let client;
    try {
      client = getAiClient();
    } catch (err: any) {
      return res.json({
        text: `Arre, you haven't set your Gemini API Key! 🙄 Please configure your API key in the platform settings so my brain can work!`,
        groundingSources: []
      });
    }

    let response = await client.models.generateContent({
      model: "gemini-3.5-flash",
      contents,
      config,
    });

    // Check for function calls
    if (response.functionCalls && response.functionCalls.length > 0) {
      const call = response.functionCalls[0];
      if (call.name === "getGmailEmails" && gmailToken) {
        const args: any = call.args || {};
        const emailData = await fetchGmailEmails(gmailToken, args.query || "", args.maxResults || 5);
        
        const functionResponsePart = {
          functionResponse: {
            name: call.name,
            id: call.id,
            response: { emails: emailData }
          }
        };

        const nextContents = [
          ...contents,
          response.candidates?.[0]?.content,
          {
            role: "tool",
            parts: [functionResponsePart]
          }
        ];

        response = await client.models.generateContent({
          model: "gemini-3.5-flash",
          contents: nextContents,
          config,
        });
      }
    }

    // Extract Grounding Chunks for UI references
    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks;
    const groundingSources: any[] = [];
    if (groundingChunks) {
      for (const chunk of groundingChunks) {
        if (chunk.web?.uri) {
          groundingSources.push({ title: chunk.web.title || chunk.web.uri, url: chunk.web.uri });
        } else if (chunk.maps?.uri) {
          groundingSources.push({ title: chunk.maps.title || "View on Google Maps", url: chunk.maps.uri });
        }
      }
    }

    res.json({
      text: response.text,
      groundingSources
    });
  } catch (err: any) {
    console.error("Zoya chat error on server:", err);
    const errMsg = err.message || String(err);
    if (errMsg.includes("API_KEY") || errMsg.includes("403") || errMsg.includes("Permission") || errMsg.includes("authentication")) {
      return res.json({
        text: `Arre, you haven't set a valid Gemini API Key! 🙄 Please check your platform settings so I can talk to you!`,
        groundingSources: []
      });
    }
    res.status(500).json({ error: errMsg });
  }
});

// Zoya TTS endpoint to offload client key usage
app.post("/api/zoya/tts", async (req, res) => {
  const { text } = req.body;
  try {
    let client;
    try {
      client = getAiClient();
    } catch (err: any) {
      return res.json({ audio: null });
    }
    const response = await client.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    res.json({ audio: base64Audio || null });
  } catch (err: any) {
    console.error("TTS generation error on server:", err);
    res.json({ audio: null });
  }
});

// 2. Initialize WebSocket Server for Gemini Live API Proxy
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", async (clientWs: WebSocket, request: http.IncomingMessage) => {
  console.log("WebSocket client connected to proxy server");

  // Extract query parameters for personalized greeting and Gmail oauth access
  const url = new URL(request.url || "", `http://${request.headers.host}`);
  const creatorName = url.searchParams.get("creatorName") || "Harikirshan lodhi";
  const gmailToken = url.searchParams.get("gmailToken") || "";

  let session: any = null;

  try {
    let ai;
    try {
      ai = getAiClient();
    } catch (err: any) {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "connected" }));
        setTimeout(() => {
          clientWs.send(JSON.stringify({ type: "text", sender: "zoya", text: "Ugh, you forgot the Gemini API Key! 🙄 Please configure your API key in the platform settings so I can talk to you!" }));
          clientWs.send(JSON.stringify({ type: "closed" }));
          clientWs.close();
        }, 500);
      }
      return;
    }

    // Setup and connect to official Gemini Live API
    session = await ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      callbacks: {
        onopen: () => {
          console.log("Gemini Live API remote session established.");
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "connected" }));
          }
        },
        onmessage: (message: any) => {
          if (clientWs.readyState !== WebSocket.OPEN) return;

          // 1. Handle Audio output stream bytes from model
          const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio) {
            clientWs.send(JSON.stringify({ type: "audio", data: audio }));
          }

          // 2. Handle interruption trigger signal
          if (message.serverContent?.interrupted) {
            clientWs.send(JSON.stringify({ type: "interrupted" }));
          }

          // 3. Handle live incremental model text/transcription
          const text = message.serverContent?.modelTurn?.parts?.[0]?.text;
          if (text) {
            clientWs.send(JSON.stringify({ type: "text", sender: "zoya", text }));
          }

          // 4. Handle tool function calls
          const functionCalls = message.toolCall?.functionCalls;
          if (functionCalls && functionCalls.length > 0) {
            for (const call of functionCalls) {
              if (call.name === "executeBrowserAction") {
                clientWs.send(
                  JSON.stringify({
                    type: "command",
                    callId: call.id,
                    name: call.name,
                    args: call.args,
                  })
                );
              } else if (call.name === "getGmailEmails" && gmailToken) {
                console.log("Live API connection triggering getGmailEmails tool execution...");
                fetchGmailEmails(gmailToken, call.args?.query || "", call.args?.maxResults || 5)
                  .then((emailData) => {
                    if (session) {
                      session.sendToolResponse({
                        functionResponses: [{
                          name: call.name,
                          id: call.id,
                          response: { emails: emailData }
                        }]
                      });
                    }
                  })
                  .catch((e) => {
                    console.error("Live fetch Gmail emails error: ", e);
                    if (session) {
                      session.sendToolResponse({
                        functionResponses: [{
                          name: call.name,
                          id: call.id,
                          response: { error: String(e) }
                        }]
                      });
                    }
                  });
              }
            }
          }
        },
        onclose: () => {
          console.log("Gemini Live API remote session closed.");
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "closed" }));
            clientWs.close();
          }
        },
        onerror: (err: any) => {
          console.error("Gemini Live API Remote Error: ", err);
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(
              JSON.stringify({
                type: "error",
                error: err instanceof Error ? err.message : String(err),
              })
            );
            clientWs.close();
          }
        },
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
        systemInstruction: getZoyaSystemInstruction(creatorName),
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [
          {
            functionDeclarations: [
              {
                name: "executeBrowserAction",
                description:
                  "Open a website or perform a browser action (like opening YouTube, Spotify, or WhatsApp). Call this when the user asks to open a site, play a song, or send a message.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    actionType: {
                      type: Type.STRING,
                      description: "Type of action: 'open', 'youtube', 'spotify', 'whatsapp'",
                    },
                    query: {
                      type: Type.STRING,
                      description: "The search query, website name, or message content.",
                    },
                    target: {
                      type: Type.STRING,
                      description: "The target phone number for WhatsApp, if applicable.",
                    },
                  },
                  required: ["actionType", "query"],
                },
              },
              ...(gmailToken ? [{
                name: "getGmailEmails",
                description: "Get the user's latest received emails or search Gmail inbox using simplified parameters.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    query: {
                      type: Type.STRING,
                      description: "Optional query to filter emails (e.g., 'from:boss', 'subject:report', or keyword 'meeting')",
                    },
                    maxResults: {
                      type: Type.NUMBER,
                      description: "Maximum number of email summaries to fetch. Defaults to 5.",
                    }
                  }
                }
              }] : [])
            ],
          },
        ],
      },
    });

    // Accept raw client microphone frames or manual voice commands
    clientWs.on("message", (msgData: any) => {
      if (!session) return;
      try {
        const parsed = JSON.parse(msgData.toString());
        if (parsed.type === "audio" && parsed.data) {
          session.sendRealtimeInput({
            audio: { data: parsed.data, mimeType: "audio/pcm;rate=16000" },
          });
        } else if (parsed.type === "text" && parsed.data) {
          session.sendRealtimeInput({
            text: parsed.data,
          });
        } else if (parsed.type === "toolResponse" && parsed.response) {
          session.sendToolResponse({
            functionResponses: [parsed.response],
          });
        }
      } catch (err) {
        console.error("Error processing client ws message: ", err);
      }
    });

    clientWs.on("close", () => {
      console.log("WebSocket client disconnected. Closing Gemini session.");
      if (session) {
        try {
          session.close();
        } catch (e) {
          // ignore
        }
        session = null;
      }
    });
  } catch (error: any) {
    console.error("Error creating Gemini Live API Remote Connection: ", error);
    const errMsg = error instanceof Error ? error.message : String(error);
    if (clientWs.readyState === WebSocket.OPEN) {
      if (errMsg.includes("API_KEY") || errMsg.includes("403") || errMsg.includes("Permission") || errMsg.includes("authentication")) {
        clientWs.send(JSON.stringify({ type: "connected" }));
        setTimeout(() => {
          clientWs.send(JSON.stringify({ type: "text", sender: "zoya", text: "Microphone blocked by API Key permissions! 😶 Please add a valid Gemini API Key from Settings!" }));
          clientWs.send(JSON.stringify({ type: "closed" }));
          clientWs.close();
        }, 500);
      } else {
        clientWs.send(
          JSON.stringify({
            type: "error",
            error: errMsg,
          })
        );
        clientWs.close();
      }
    }
  }
});

// Handle WebSocket upgrade manually
server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "", `http://${request.headers.host}`).pathname;
  if (pathname.startsWith("/api/live")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// 3. Vite Middleware integration
async function serveApp() {
  if (process.env.NODE_ENV !== "production") {
    console.log("Starting server in DEVELOPMENT mode with Vite Middleware.");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    console.log("Starting server in PRODUCTION mode with compiled static distribution.");
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Zoya assistant backend running on http://localhost:${PORT}`);
  });
}

serveApp();

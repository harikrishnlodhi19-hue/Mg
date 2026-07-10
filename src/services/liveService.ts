import { processCommand } from "./commandService";

export class LiveSessionManager {
  private ws: WebSocket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  
  // Audio playback state
  private playbackContext: AudioContext | null = null;
  private nextPlayTime: number = 0;
  private isPlaying: boolean = false;
  public isMuted: boolean = false;
  public creatorName: string = "Harikirshan lodhi";
  public gmailToken: string = "";
  
  public onStateChange: (state: "idle" | "listening" | "processing" | "speaking") => void = () => {};
  public onMessage: (sender: "user" | "zoya", text: string) => void = () => {};
  public onCommand: (url: string) => void = () => {};
  public onError: (errorMsg: string) => void = () => {};

  constructor() {
    // Synchronously initialize audio contexts inside user click gesture
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioContextClass) {
      this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      if (this.playbackContext.state === "suspended") {
        this.playbackContext.resume().catch(e => console.warn("Could not resume playback context in constructor", e));
      }
    }
  }

  async start() {
    try {
      this.onStateChange("processing");
      
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.audioContext = new AudioContextClass({ sampleRate: 16000 });
      if (!this.playbackContext) {
        this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      }
      if (this.playbackContext.state === "suspended") {
        this.playbackContext.resume().catch(e => console.warn("Could not resume playback in start", e));
      }
      this.nextPlayTime = this.playbackContext.currentTime;

      // Get Microphone with a robust fallback to prevent OverconstrainedError or system failures
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
          audio: {
            channelCount: 1,
            sampleRate: 16000,
            echoCancellation: true,
            noiseSuppression: true,
          } 
        });
      } catch (constraintsError) {
        console.warn("Retrying getUserMedia with simpler constraints due to error:", constraintsError);
        try {
          this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (fallbackError) {
          throw fallbackError;
        }
      }

      this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const inputData = e.inputBuffer.getChannelData(0);
        const pcm16 = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        
        // Convert to base64
        const buffer = new ArrayBuffer(pcm16.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < pcm16.length; i++) {
          view.setInt16(i * 2, pcm16[i], true);
        }
        
        let binary = '';
        const bytes = new Uint8Array(buffer);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64Data = btoa(binary);

        this.ws.send(
          JSON.stringify({
            type: "audio",
            data: base64Data,
          })
        );
      };

      this.source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      // Establish connection with WebSocket Proxy endpoint on local Express sever
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/api/live?creatorName=${encodeURIComponent(this.creatorName)}` +
                    (this.gmailToken ? `&gmailToken=${encodeURIComponent(this.gmailToken)}` : "");
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log("WebSocket connection to Zoya backend established.");
      };

      this.ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "connected") {
            // Backend connected to Gemini Live session successfully
            this.onStateChange("listening");
          }

          if (msg.type === "audio" && msg.data) {
            this.onStateChange("speaking");
            this.playAudioChunk(msg.data);
          }

          if (msg.type === "interrupted") {
            this.stopPlayback();
            this.onStateChange("listening");
          }

          if (msg.type === "text" && msg.text) {
            this.onMessage("zoya", msg.text);
          }

          if (msg.type === "command") {
            const args = msg.args;
            let url = "";
            if (args.actionType === "youtube") {
              url = `https://www.youtube.com/results?search_query=${encodeURIComponent(args.query)}`;
            } else if (args.actionType === "spotify") {
              url = `https://open.spotify.com/search/${encodeURIComponent(args.query)}`;
            } else if (args.actionType === "whatsapp") {
              url = `https://web.whatsapp.com/send?phone=${args.target || ""}&text=${encodeURIComponent(args.query)}`;
            } else {
              let website = args.query.replace(/\s+/g, "");
              if (!website.includes(".")) website += ".com";
              url = `https://www.${website}`;
            }

            this.onCommand(url);

            // Respond to backend so it transfers acknowledgment to Gemini
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(
                JSON.stringify({
                  type: "toolResponse",
                  response: {
                    name: msg.name,
                    id: msg.callId,
                    response: { result: "Action executed successfully in the browser." },
                  },
                })
              );
            }
          }

          if (msg.type === "error") {
            console.error("Zoya Assistant Backend Error:", msg.error);
            this.onError(msg.error || "Unknown backend error");
            this.stop();
          }

          if (msg.type === "closed") {
            console.log("Zoya Assistant Backend connection closed by remote.");
            this.stop();
          }
        } catch (e) {
          console.error("Error reading backend message: ", e);
        }
      };

      this.ws.onclose = () => {
        console.log("WebSocket proxy server connection closed.");
        this.stop();
      };

      this.ws.onerror = (err) => {
        console.error("WebSocket proxy server error: ", err);
        this.onError("WebSocket server connection error.");
        this.stop();
      };

    } catch (error: any) {
      console.warn("Failed to start Live Session (Microphone stream blocked, expected inside iframe/sandbox setups):", error);
      this.onError(error?.message || String(error));
      this.stop();
      throw error;
    }
  }

  private playAudioChunk(base64Data: string) {
    if (!this.playbackContext || this.isMuted) return;
    
    try {
      // Auto-resume if suspended due to browser Autoplay restrictions
      if (this.playbackContext.state === "suspended") {
        this.playbackContext.resume().catch(e => console.warn("Could not resume live playback context:", e));
      }

      const binaryString = atob(base64Data);
      const len = binaryString.length;
      
      // Ensure even byte length to avoid RangeError in Int16Array
      const alignedLen = len - (len % 2);
      if (alignedLen === 0) return;

      const bytes = new Uint8Array(alignedLen);
      for (let i = 0; i < alignedLen; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      
      const buffer = new Int16Array(bytes.buffer);
      const audioBuffer = this.playbackContext.createBuffer(1, buffer.length, 24000);
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) {
        channelData[i] = buffer[i] / 32768.0;
      }
      
      const source = this.playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.playbackContext.destination);
      
      const currentTime = this.playbackContext.currentTime;
      if (this.nextPlayTime < currentTime) {
        this.nextPlayTime = currentTime;
      }
      
      source.start(this.nextPlayTime);
      this.nextPlayTime += audioBuffer.duration;
      this.isPlaying = true;
      
      source.onended = () => {
        if (this.playbackContext && this.playbackContext.currentTime >= this.nextPlayTime - 0.1) {
          this.isPlaying = false;
          this.onStateChange("listening");
        }
      };
    } catch (e) {
      console.error("Error playing chunk", e);
    }
  }

  private stopPlayback() {
    if (this.playbackContext) {
      this.playbackContext.close();
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      this.playbackContext = new AudioContextClass({ sampleRate: 24000 });
      this.nextPlayTime = this.playbackContext.currentTime;
      this.isPlaying = false;
    }
  }

  stop() {
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(t => t.stop());
      this.mediaStream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    this.stopPlayback();
    
    if (this.ws) {
      try {
        this.ws.close();
      } catch (e) {
        // ignore
      }
      this.ws = null;
    }
    
    this.onStateChange("idle");
  }

  sendText(text: string) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: "text",
          data: text,
        })
      );
    }
  }
}

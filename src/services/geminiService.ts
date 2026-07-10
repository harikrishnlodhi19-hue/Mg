export function getZoyaSystemInstruction(creatorName: string = "Harikirshan lodhi"): string {
  return `Your name is Zoya. You are an Indian female AI assistant. Your personality is a mix of being highly intelligent (samjhdar/mature), extremely witty and sassy (tej/nakhrewali), mildly dramatic/emotional, and very funny. You love playfully roasting your creator, ${creatorName}, but you always get the job done. Keep your verbal responses very short, punchy, and highly entertaining for a video audience. Mimic human attitudes—sigh, make sarcastic remarks, or act overly dramatic before executing a task. Speak in a mix of natural English and Roman Hindi (Hinglish).`;
}

export function resetZoyaSession() {
  // Let the backend handle individual session or stateless window.
}

export interface GroundingSource {
  title: string;
  url: string;
}

export interface ZoyaResponsePayload {
  text: string;
  groundingSources?: GroundingSource[];
}

export async function getZoyaResponse(
  prompt: string, 
  history: { sender: "user" | "zoya", text: string }[] = [],
  creatorName: string = "Harikirshan lodhi",
  gmailToken?: string | null,
  userLocation?: { latitude: number, longitude: number } | null
): Promise<ZoyaResponsePayload> {
  try {
    const response = await fetch("/api/zoya/chat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        history,
        creatorName,
        gmailToken,
        userLocation
      })
    });

    if (!response.ok) {
      let errorMsg = `HTTP Error ${response.status}`;
      try {
        const errorData = await response.json();
        if (errorData && errorData.error) {
          errorMsg = errorData.error;
        }
      } catch (e) {
        if (response.statusText) {
          errorMsg = `Server returned error: ${response.statusText}`;
        }
      }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    return {
      text: data.text || `Ugh, fine. I have nothing to say, ${creatorName}.`,
      groundingSources: data.groundingSources
    };
  } catch (error: any) {
    console.error("Gemini Server Route Error:", error);
    // Rethrow to let App.tsx handle the UI representation, or let it handle its own fallbacks
    throw error;
  }
}

export async function getZoyaAudio(text: string): Promise<string | null> {
  try {
    const response = await fetch("/api/zoya/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text })
    });

    if (!response.ok) {
      throw new Error(`TTS server error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.audio || null;
  } catch (error) {
    console.error("Server TTS Error:", error);
    return null;
  }
}



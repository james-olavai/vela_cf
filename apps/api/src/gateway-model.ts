import type { Genkit } from "genkit";

// Evaluation-only adapter: no fallback model, no secret in diagnostics.
export const HYDROGEN_GATEWAY_MODEL = "gateway/gemini-4-hydrogen";
export function toGatewayMessages(messages: any[]) {
  return messages.flatMap((message) => {
    if (message.role === "tool")
      return message.content
        .filter((p: any) => p.toolResponse)
        .map((p: any) => ({
          role: "tool",
          tool_call_id: p.toolResponse.ref,
          content: JSON.stringify(p.toolResponse.output),
        }));
    const calls = message.content
      .filter((p: any) => p.toolRequest)
      .map((p: any) => ({
        id: p.toolRequest.ref,
        type: "function",
        function: {
          name: p.toolRequest.name,
          arguments: JSON.stringify(p.toolRequest.input),
        },
        ...(p.metadata?.gatewayExtraContent
          ? { extra_content: p.metadata.gatewayExtraContent }
          : {}),
      }));
    const extra = message.metadata?.gatewayExtraContent;
    return [
      {
        role: message.role === "model" ? "assistant" : message.role,
        content:
          message.content
            .filter((p: any) => typeof p.text === "string")
            .map((p: any) => p.text)
            .join("\n") || null,
        ...(calls.length ? { tool_calls: calls } : {}),
        ...(extra ? { extra_content: extra } : {}),
      },
    ];
  });
}
export function registerHydrogenGateway(
  ai: Genkit,
  options: {
    token: string;
    maxOutputTokens?: number;
    baseUrl?: string;
    signal?: AbortSignal;
    onResponse?: (record: unknown) => void;
  },
) {
  return ai.defineModel(
    {
      name: HYDROGEN_GATEWAY_MODEL,
      supports: {
        multiturn: true,
        tools: true,
        systemRole: true,
        media: false,
      },
    },
    async (request) => {
      const tools = request.tools?.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
      const response = await fetch(
        `${(options.baseUrl || "http://192.168.8.10:8088/v1").replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          signal: options.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.token}`,
          },
          body: JSON.stringify({
            model: "gemini-4-hydrogen",
            messages: toGatewayMessages(request.messages),
            ...(tools?.length ? { tools, tool_choice: "auto" } : {}),
            stream: false,
            max_tokens:
              options.maxOutputTokens ||
              request.config?.maxOutputTokens ||
              4096,
          }),
        },
      );
      if (!response.ok)
        throw new Error(`Hydrogen 网关返回 HTTP ${response.status}`);
      const data: any = await response.json();
      const choice = data.choices?.[0],
        message = choice?.message;
      if (!message) throw new Error("Hydrogen 网关没有返回消息");
      if (data.model && !String(data.model).includes("gemini-4-hydrogen"))
        throw new Error("网关返回的模型不是 Hydrogen，停止比较");
      const content: any[] = [];
      if (message.content) content.push({ text: message.content });
      for (const call of message.tool_calls || [])
        content.push({
          toolRequest: {
            name: call.function.name,
            input: JSON.parse(call.function.arguments || "{}"),
            ref: call.id,
          },
          ...(call.extra_content
            ? { metadata: { gatewayExtraContent: call.extra_content } }
            : {}),
        });
      options.onResponse?.({
        model: data.model || "unreported",
        requestedMaxOutputTokens:
          options.maxOutputTokens || request.config?.maxOutputTokens || 4096,
        usage: data.usage,
        finishReason: choice.finish_reason,
        toolCalls: (message.tool_calls || []).map((call: any) => ({
          id: call.id,
          name: call.function.name,
          hasThoughtSignature: !!call.extra_content?.google?.thought_signature,
        })),
      });
      return {
        message: {
          role: "model",
          content,
          ...(message.extra_content
            ? { metadata: { gatewayExtraContent: message.extra_content } }
            : {}),
        },
        finishReason: choice.finish_reason === "length" ? "length" : "stop",
        usage: {
          inputTokens: data.usage?.prompt_tokens,
          outputTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
          thoughtsTokens:
            data.usage?.completion_tokens_details?.reasoning_tokens,
        },
      };
    },
  );
}

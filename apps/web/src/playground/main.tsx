import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AstroUiRenderer } from "../components/AstroUiRenderer";
import { ChartFactCard } from "../components/ChartFactCard";
import type { AstroUiBlock } from "@vela-cf/shared";
import type { ChartSnapshot } from "../lib/store";
import "../index.css";
import "./style.css";
type Profile = {
  name: string;
  birthDateTime: string;
  latitude: number;
  longitude: number;
  locationName: string;
  timezone: string;
  gender: string;
};
type Bundle = {
  revision: string;
  systemPrompt: string;
  outputInstructions: string;
  modelName: string;
  temperature: number;
  skills: Record<
    string,
    {
      title: string;
      summary: string;
      reference: string;
    }
  >;
  toolDescriptions: Record<string, string>;
  templates: Record<string, string>;
  allowedTools: string[];
};
type Product = {
  id: string;
  name: string;
  tier: string;
  bundle: Bundle;
};
type Case = {
  id: string;
  name: string;
  message: string;
  profiles: Profile[];
  referenceTime?: string;
  fixtures?: unknown[];
  depth?: string;
};
type Run = {
  text: string;
  rawText: string;
  suggestions: string[];
  uiBlocks: AstroUiBlock[];
  chart?: ChartSnapshot;
  diagnostics: Record<string, unknown>;
};
type Snapshot = {
  productId: string;
  bundle: Bundle;
  profiles: Profile[];
  message: string;
  referenceTime: string;
  depth: string;
  toolMode: string;
  history: {
    role: string;
    text: string;
  }[];
  fixtures?: unknown[];
};
type Version = {
  name: string;
  note: string;
  input: Snapshot;
  result?: Run;
  createdAt: string;
  ratings: Record<string, string>;
};
type Bootstrap = {
  token: string;
  products: Product[];
  cases?: Case[];
  guardrails: string;
  ready: boolean;
};
const KEY = "vela-playground-v1";
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function App() {
  const [boot, setBoot] = useState<Bootstrap>();
  const [input, setInput] = useState<Snapshot>();
  const [versions, setVersions] = useState<Version[]>([]);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("正在连接本地工作台…");
  const [tab, setTab] = useState("角色与风格");
  const [skill, setSkill] = useState("");
  const [tool, setTool] = useState("");
  const [result, setResult] = useState<Run>();
  const [resultInput, setResultInput] = useState("");
  const [running, setRunning] = useState(false);
  const [compare, setCompare] = useState(false);
  const [base, setBase] = useState("");
  const [baseResult, setBaseResult] = useState<Run>();
  const [view, setView] = useState("回答");
  const [mobile, setMobile] = useState("设置");
  const [ratings, setRatings] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [versionName, setVersionName] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    fetch("/api/playground/bootstrap")
      .then(async (r) => {
        if (!r.ok) throw Error("本地服务未就绪，请联系负责安装的同事");
        return r.json();
      })
      .then((b: Bootstrap) => {
        setBoot(b);
        try {
          const saved = localStorage.getItem(KEY);
          if (saved) {
            const s = JSON.parse(saved);
            setInput(s.input);
            setVersions(s.versions || []);
            setStatus("已恢复本地草稿");
            return;
          }
        } catch {}
        const p = b.products[0];
        const c = b.cases?.[0];
        if (p)
          setInput({
            productId: p.id,
            bundle: clone(p.bundle),
            profiles: c?.profiles || [],
            message: c?.message || "",
            referenceTime: c?.referenceTime || "2026-07-15T12:00:00Z",
            depth: c?.depth || "balanced",
            toolMode: "live",
            history: [],
            fixtures: c?.fixtures,
          });
        setStatus(
          b.ready
            ? "本地草稿 · 尚未上线"
            : "模型连接尚未配置，请联系负责安装的同事",
        );
      })
      .catch((e) => setStatus(e.message));
  }, []);
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [dirty]);
  function patch(change: Partial<Snapshot>) {
    if (!input) return;
    setInput({ ...input, ...change });
    setDirty(true);
  }
  function bundle(change: Partial<Bundle>) {
    if (input) patch({ bundle: { ...input.bundle, ...change } });
  }
  function save(next = versions) {
    if (!input) return false;
    try {
      localStorage.setItem(KEY, JSON.stringify({ input, versions: next }));
      setDirty(false);
      setStatus(`已保存 ${new Date().toLocaleTimeString()} · 尚未上线`);
      return true;
    } catch {
      setStatus("保存失败：本地空间不足，请导出交付包备份");
      return false;
    }
  }
  function switchSafe(action: () => void) {
    if (
      dirty &&
      !confirm("当前有未保存修改。点击确定保存后继续，取消返回编辑。")
    )
      return;
    if (dirty && !save()) return;
    action();
  }
  async function request(snapshot: Snapshot, signal: AbortSignal) {
    const r = await fetch("/api/playground/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${boot?.token}`,
      },
      body: JSON.stringify(snapshot),
      signal,
    });
    const data = await r.json();
    if (!r.ok)
      throw Error(
        data.error ||
          data.message ||
          "生成失败，请检查设置或联系负责安装的同事",
      );
    return data as Run;
  }
  async function run(previewOnly = false) {
    if (!input || !boot || running) return;
    if (!input.message.trim() || !input.profiles.length) {
      setStatus("请选择测试星盘并填写咨询问题");
      return;
    }
    const snapshot = { ...clone(input), previewOnly };
    controller.current = new AbortController();
    setRunning(true);
    setStatus("正在计算星盘并生成解读…");
    setRatings({});
    setBaseResult(undefined);
    try {
      if (compare) {
        const v = versions[Number(base)];
        if (base === "" || !v) throw Error("请先选择基线版本");
        const baseline = {
          ...snapshot,
          productId: v.input.productId,
          bundle: clone(v.input.bundle),
        };
        setBaseResult(await request(baseline, controller.current.signal));
      }
      const r = await request(snapshot, controller.current.signal);
      setResult(r);
      setResultInput(JSON.stringify(input));
      setStatus(previewOnly ? "检查通过，尚未调用模型；请点击开始解读生成回答" : "解读完成，请检查事实与表达");
    } catch (e) {
      setStatus(
        e instanceof Error && e.name === "AbortError"
          ? "已停止，本次结果不完整；已发生调用仍可能计费"
          : e instanceof Error
            ? e.message
            : "生成失败",
      );
    } finally {
      setRunning(false);
    }
  }
  function saveVersion() {
    if (!input || !versionName.trim()) {
      setStatus("请填写版本名称");
      return;
    }
    const v: Version = {
      name: versionName.trim(),
      note,
      input: clone(input),
      result: resultInput === JSON.stringify(input) ? result : undefined,
      createdAt: new Date().toISOString(),
      ratings: clone(ratings),
    };
    const next = [...versions, v];
    setVersions(next);
    save(next);
    setVersionName("");
  }
  function renderResult(r?: Run) {
    return r ? (
      <>
        <article className="answer">{r.text || "星盘与设置检查完成，尚未生成解读。"}</article>
        {r.chart?.natal && (
          <ChartFactCard
            chart={r.chart}
            profileName={
              input?.profiles.map((p) => p.name).join(" × ") || "测试星盘"
            }
          />
        )}
        <AstroUiRenderer
          blocks={r.uiBlocks || []}
          disabled={running}
          onQuickAsk={(message) => patch({ message })}
        />
        <div className="suggestions">
          {r.suggestions?.map((s) => (
            <button
              key={s}
              disabled={running}
              onClick={() => patch({ message: s })}
            >
              {s}
            </button>
          ))}
        </div>
        <small>
          耗时 {String(r.diagnostics?.elapsedMs ?? "未知")} ms · 预估费用{" "}
          {r.diagnostics?.costMicroUsd === undefined
            ? "暂无法估算"
            : `$${Number(r.diagnostics.costMicroUsd) / 1000000}`}
        </small>
      </>
    ) : (
      <p className="empty">选择案例后点击“开始解读”。</p>
    );
  }
  if (!input || !boot)
    return (
      <main className="pg">
        <h1>Vela 解读工作台</h1>
        <p role="status">{status}</p>
        <button onClick={() => location.reload()}>重新连接</button>
      </main>
    );
  const currentSkill = skill || Object.keys(input.bundle.skills || {})[0];
  const currentTool =
    tool || Object.keys(input.bundle.toolDescriptions || {})[0];
  const stale = !!result && resultInput !== JSON.stringify(input);
  return (
    <main className="pg">
      <header>
        <div>
          <h1>Vela 解读工作台</h1>
          <span className="badge">本地草稿 · 尚未上线</span>
        </div>
        <label>
          咨询产品
          <select
            value={input.productId}
            onChange={(e) =>
              switchSafe(() => {
                const p = boot.products.find((p) => p.id === e.target.value)!;
                patch({ productId: p.id, bundle: clone(p.bundle) });
                setSkill("");
                setTool("");
              })
            }
          >
            {boot.products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <div className="actions">
          <button onClick={() => save()}>保存草稿</button>
          <button onClick={() => setCompare(!compare)} aria-pressed={compare}>
            版本对比
          </button>
          <button disabled={running} onClick={() => void run(true)}>
            检查星盘与设置
          </button>
          <button
            className="primary"
            disabled={!boot.ready}
            onClick={() => (running ? controller.current?.abort() : void run())}
          >
            {running ? "停止" : compare ? "运行对比" : "开始解读"}
          </button>
        </div>
      </header>
      <div className="notice" role="status" aria-live="polite">
        {dirty ? "有未保存修改 · " : ""}
        {status}
        {stale ? " · 当前设置已变更，预览为旧结果" : ""}
      </div>
      <nav className="mobile-tabs">
        {["案例", "设置", "预览"].map((t) => (
          <button
            key={t}
            onClick={() => setMobile(t)}
            aria-pressed={mobile === t}
          >
            {t}
          </button>
        ))}
      </nav>
      <div className="workspace">
        <aside className={`panel cases mobile-${mobile === "案例"}`}>
          <h2>测试案例</h2>
          <label>
            内置星盘与咨询
            <select
              defaultValue=""
              onChange={(e) =>
                switchSafe(() => {
                  const c = boot.cases?.find((c) => c.id === e.target.value);
                  if (c)
                    patch({
                      profiles: clone(c.profiles),
                      message: c.message,
                      referenceTime: c.referenceTime || input.referenceTime,
                      fixtures: c.fixtures,
                      depth: c.depth || input.depth,
                    });
                })
              }
            >
              <option value="" disabled>
                选择案例
              </option>
              {boot.cases?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          {input.profiles.map((p, i) => (
            <details key={i}>
              <summary>
                {p.name} · {p.locationName || p.timezone}
              </summary>
              {(
                [
                  "name",
                  "birthDateTime",
                  "locationName",
                  "timezone",
                  "latitude",
                  "longitude",
                  "gender",
                ] as const
              ).map((k) => (
                <label key={k}>
                  {
                    {
                      name: "测试代号",
                      birthDateTime: "出生时间",
                      locationName: "出生地点",
                      timezone: "时区",
                      latitude: "纬度",
                      longitude: "经度",
                      gender: "性别（male/female/unset）",
                    }[k]
                  }
                  <input
                    type={
                      k === "latitude" || k === "longitude"
                        ? "number"
                        : k === "birthDateTime"
                          ? "datetime-local"
                          : "text"
                    }
                    value={p[k]}
                    onChange={(e) =>
                      patch({
                        profiles: input.profiles.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                [k]:
                                  k === "latitude" || k === "longitude"
                                    ? Number(e.target.value)
                                    : e.target.value,
                              }
                            : x,
                        ),
                      })
                    }
                  />
                </label>
              ))}
              <small>编辑内置资料只影响当前草稿。</small>
            </details>
          ))}
          <label>
            咨询问题
            <textarea
              value={input.message}
              maxLength={2000}
              onChange={(e) => patch({ message: e.target.value })}
            />
          </label>
          <label>
            解读深度
            <select
              value={input.depth}
              onChange={(e) => patch({ depth: e.target.value })}
            >
              <option value="quick">快速</option>
              <option value="balanced">标准</option>
              <option value="deep">深入</option>
            </select>
          </label>
          <details>
            <summary>更多案例设置</summary>
            <label>
              参考日期
              <input
                value={input.referenceTime}
                onChange={(e) => patch({ referenceTime: e.target.value })}
              />
            </label>
            <label>
              盘面模式
              <select
                value={input.toolMode}
                onChange={(e) => patch({ toolMode: e.target.value })}
              >
                <option value="live">实时排盘</option>
                <option value="fixture">使用固定盘面</option>
              </select>
            </label>
            <small>固定盘面保持数据一致；缺少所需技法时会停止运行。</small>
            <h3>历史消息</h3>
            {input.history.map((h, i) => (
              <label key={i}>
                {h.role === "user" ? "用户" : "顾问"}
                <textarea
                  value={h.text}
                  onChange={(e) =>
                    patch({
                      history: input.history.map((x, j) =>
                        j === i ? { ...x, text: e.target.value } : x,
                      ),
                    })
                  }
                />
                <button
                  onClick={() =>
                    patch({ history: input.history.filter((_, j) => j !== i) })
                  }
                >
                  删除消息
                </button>
              </label>
            ))}
            <button
              onClick={() =>
                patch({
                  history: [
                    ...input.history,
                    {
                      role:
                        input.history.at(-1)?.role === "user"
                          ? "assistant"
                          : "user",
                      text: "",
                    },
                  ],
                })
              }
            >
              添加历史消息
            </button>
          </details>
        </aside>
        <section className={`panel editor mobile-${mobile === "设置"}`}>
          <h2>解读设置</h2>
          <small>修改只保存在当前产品草稿，不自动影响其他产品。</small>
          <nav className="tabs">
            {[
              "角色与风格",
              "技法指南",
              "技法说明",
              "回答结构",
              "上下文模板",
            ].map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-pressed={tab === t}
              >
                {t}
              </button>
            ))}
          </nav>
          {tab === "角色与风格" && (
            <label>
              顾问角色、解读目标与表达方式
              <textarea
                className="large"
                value={input.bundle.systemPrompt}
                onChange={(e) => bundle({ systemPrompt: e.target.value })}
              />
            </label>
          )}
          {tab === "回答结构" && (
            <label>
              回答与追问格式
              <textarea
                className="large"
                value={input.bundle.outputInstructions}
                onChange={(e) => bundle({ outputInstructions: e.target.value })}
              />
            </label>
          )}
          {tab === "技法指南" && (
            <>
              <label>
                选择技法
                <select
                  value={currentSkill || ""}
                  onChange={(e) => setSkill(e.target.value)}
                >
                  {Object.entries(input.bundle.skills || {}).map(([k, v]) => (
                    <option value={k} key={k}>
                      {v.title}
                    </option>
                  ))}
                </select>
              </label>
              {currentSkill &&
                input.bundle.skills[currentSkill] &&
                (["title", "summary", "reference"] as const).map((k) => (
                  <label key={k}>
                    {
                      {
                        title: "指南名称",
                        summary: "技法摘要",
                        reference: "解读指南正文",
                      }[k]
                    }
                    <textarea
                      className={k === "reference" ? "large" : ""}
                      value={input.bundle.skills[currentSkill][k]}
                      onChange={(e) =>
                        bundle({
                          skills: {
                            ...input.bundle.skills,
                            [currentSkill]: {
                              ...input.bundle.skills[currentSkill],
                              [k]: e.target.value,
                            },
                          },
                        })
                      }
                    />
                  </label>
                ))}
            </>
          )}
          {tab === "技法说明" && (
            <>
              <label>
                排盘技法
                <select
                  value={currentTool || ""}
                  onChange={(e) => setTool(e.target.value)}
                >
                  {Object.keys(input.bundle.toolDescriptions || {}).map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </label>
              {currentTool && (
                <label>
                  如何向模型说明此技法
                  <textarea
                    className="large"
                    value={input.bundle.toolDescriptions[currentTool]}
                    onChange={(e) =>
                      bundle({
                        toolDescriptions: {
                          ...input.bundle.toolDescriptions,
                          [currentTool]: e.target.value,
                        },
                      })
                    }
                  />
                </label>
              )}
              <small>说明文字不会改变工具权限或计算方式。</small>
            </>
          )}
          {tab === "上下文模板" &&
            Object.entries(input.bundle.templates || {}).map(([k, v]) => (
              <label key={k}>
                {{
                  profile: "出生资料呈现",
                  facts: "已验证盘面事实",
                  history: "历史消息",
                  route: "技法选择提示",
                }[k] || k}
                <textarea
                  value={v}
                  onChange={(e) =>
                    bundle({
                      templates: {
                        ...input.bundle.templates,
                        [k]: e.target.value,
                      },
                    })
                  }
                />
                <small>保留原有变量名称；服务器会验证模板。</small>
              </label>
            ))}
          <details>
            <summary>固定规则（只读）</summary>
            <pre>
              {typeof boot.guardrails === "string"
                ? boot.guardrails
                : JSON.stringify(boot.guardrails, null, 2)}
            </pre>
          </details>
          <details>
            <summary>高级模型设置</summary>
            <label>
              模型
              <input
                value={input.bundle.modelName}
                onChange={(e) => bundle({ modelName: e.target.value })}
              />
            </label>
            <label>
              温度
              <input
                type="number"
                min="0"
                max="2"
                step="0.1"
                value={input.bundle.temperature}
                onChange={(e) =>
                  bundle({ temperature: Number(e.target.value) })
                }
              />
            </label>
          </details>
          <fieldset>
            <legend>保存版本与交付</legend>
            <label>
              版本名称
              <input
                value={versionName}
                onChange={(e) => setVersionName(e.target.value)}
              />
            </label>
            <label>
              修改说明
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            <button onClick={saveVersion}>保存版本</button>
            <label>
              已保存版本
              <select value={base} onChange={(e) => setBase(e.target.value)}>
                <option value="">选择基线版本</option>
                {versions.map((v, i) => (
                  <option key={i} value={i}>
                    {v.name} · {new Date(v.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={base === ""}
              onClick={() =>
                switchSafe(() => {
                  const v = versions[Number(base)];
                  setInput(clone(v.input));
                  setDirty(true);
                  setResult(v.result);
                  setResultInput(v.result ? JSON.stringify(v.input) : "");
                })
              }
            >
              从所选版本创建草稿
            </button>
            <button
              onClick={() => {
                download("vela-交付包.json", {
                  schemaVersion: 1,
                  versionName,
                  note,
                  input,
                  result: !stale ? result : undefined,
                  ratings,
                  versions,
                  unresolved: stale
                    ? "结果已过期"
                    : !result
                      ? "尚未运行"
                      : "请检查评价",
                });
                setStatus("已导出，请交由负责发布的同事处理");
              }}
            >
              导出交付包
            </button>
          </fieldset>
        </section>
        <section className={`panel preview mobile-${mobile === "预览"}`}>
          <h2>{compare ? "版本对比" : "回答预览"}</h2>
          <p className="muted">模型调用会产生费用，停止后仍可能计费。</p>
          <nav className="tabs">
            {["回答", "本次依据", "高级诊断"].map((t) => (
              <button
                key={t}
                onClick={() => setView(t)}
                aria-pressed={view === t}
              >
                {t}
              </button>
            ))}
          </nav>
          {view === "回答" ? (
            compare ? (
              <div className="comparison">
                <div>
                  <h3>基线版本</h3>
                  {renderResult(baseResult)}
                </div>
                <div>
                  <h3>当前草稿</h3>
                  {renderResult(result)}
                </div>
              </div>
            ) : (
              renderResult(result)
            )
          ) : view === "本次依据" ? (
            <>
              <p>以下是可核查的调用记录，不是模型内部思维过程。</p>
              <pre>
                {JSON.stringify(
                  result?.diagnostics?.calls || "尚未运行",
                  null,
                  2,
                )}
              </pre>
              <h3>开放的技法</h3>
              <pre>
                {JSON.stringify(result?.diagnostics?.tools || [], null, 2)}
              </pre>
            </>
          ) : (
            <>
              <pre>{JSON.stringify(result, null, 2) || "尚未运行"}</pre>
              <button
                onClick={() =>
                  download("vela-诊断信息.json", { input, result })
                }
              >
                导出诊断信息（包含测试输入输出）
              </button>
            </>
          )}
          {result && result.text && !stale && (
            <fieldset>
              <legend>本次评价</legend>
              {["盘面事实准确", "解读切题", "表达清楚", "技法合适"].map((k) => (
                <label key={k}>
                  {k}
                  <select
                    value={ratings[k] || "未评价"}
                    onChange={(e) =>
                      setRatings({ ...ratings, [k]: e.target.value })
                    }
                  >
                    {["未评价", "通过", "需修改"].map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </label>
              ))}
            </fieldset>
          )}
        </section>
      </div>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

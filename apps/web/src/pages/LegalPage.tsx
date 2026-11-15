import { AppFooter } from '../components/Layout';
import { navigate } from '../lib/router';

interface LegalPageProps {
  kind: 'privacy' | 'terms';
}

export function LegalPage({ kind }: LegalPageProps) {
  const isPrivacy = kind === 'privacy';

  return (
    <div className="min-h-screen bg-base text-primary flex flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 sm:px-10 py-3.5 border-b border-divider">
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          className="font-brand text-[20px] font-semibold tracking-[0.32em] text-accent no-underline py-2.5"
        >
          VELA
        </a>
        <a
          href="/"
          onClick={(e) => {
            e.preventDefault();
            navigate('/');
          }}
          className="text-[14px] text-secondary no-underline py-2 hover:text-primary"
        >
          返回首页
        </a>
      </header>

      <main className="flex-1 max-w-[820px] w-full mx-auto px-6 sm:px-10 py-12 flex flex-col gap-6 leading-[1.85] text-body">
        <h1 className="m-0 font-serif-sc text-[32px] font-bold">
          {isPrivacy ? '隐私政策' : '服务条款'}
        </h1>

        {isPrivacy ? (
          <>
            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-serif-sc text-[20px] font-bold text-accent-bright">
                1. 我们收集的信息
              </h2>
              <p className="m-0 text-[15px] text-secondary">
                我们使用 Google 登录仅读取你的邮箱、昵称与账号标识符（UID）。你主动录入的出生日期、时间、出生地点与性别用于计算星盘事实；对话内容用于生成并保存你的咨询记录。Vela
                不保存任何支付卡号，所有支付由 Stripe 独立处理。
              </p>
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-serif-sc text-[20px] font-bold text-accent-bright">
                2. 服务处理方与模型数据保护
              </h2>
              <p className="m-0 text-[15px] text-secondary">
                核心数据与 AI 推理由 Google Cloud / Firebase（主要区域为新加坡
                asia-southeast1）及 Google Cloud Vertex AI 企业级服务提供；依据 Google Cloud
                数据处理附录（CDPA），你输入的出生信息与对话内容不会被用于训练基础模型。城市经纬度查询通过
                Open-Meteo Geocoding API 进行，仅发送地名查询词，不附带个人身份标识。
              </p>
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-serif-sc text-[20px] font-bold text-accent-bright">
                3. 你的权利（导出与删除）
              </h2>
              <p className="m-0 text-[15px] text-secondary">
                你随时可以在「账号」页面一键导出全部个人档案与咨询记录（JSON
                格式），或永久删除账号及所有关联数据。
              </p>
            </section>
          </>
        ) : (
          <>
            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-serif-sc text-[20px] font-bold text-accent-bright">
                1. 适用资格与免责声明
              </h2>
              <p className="m-0 text-[15px] text-secondary">
                使用 Vela 需年满 18 周岁。Vela
                提供的排盘与 AI 解读内容仅供娱乐与自我探索参考，不构成任何医疗、心理治疗、法律、财务或投资建议。
              </p>
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-serif-sc text-[20px] font-bold text-accent-bright">
                2. 亲友档案信息授权
              </h2>
              <p className="m-0 text-[15px] text-secondary">
                当你为他人建立出生档案时，你承诺已事先征得对方同意。你可以随时在「档案」页面编辑或删除这些档案。
              </p>
            </section>
            <section className="flex flex-col gap-2">
              <h2 className="m-0 font-serif-sc text-[20px] font-bold text-accent-bright">
                3. 订阅、税费与取消
              </h2>
              <p className="m-0 text-[15px] text-secondary">
                Go 与 Pro 档位按月自动续订，结账时由 Stripe Tax 按所在地区计算适用税费。你可随时通过账单管理取消续订，当期剩余额度在账期结束前继续有效。
              </p>
            </section>
          </>
        )}
      </main>

      <AppFooter />
    </div>
  );
}

import { FeatureSwitch } from "./FeatureSwitch";
import ThemePicker from "./ThemePicker";
import { UpdatesSettings } from "./UpdateBar";
import { useEffect, useState } from "react";
import BudgetSettings from "./BudgetSettings";
import NotificationSettings from "./NotificationSettings";
import DataSettings from "./DataSettings";
import EmailSettings from "./EmailSettings";
import AiSettings from "./AiSettings";
import PlaidSettings from "./PlaidSettings";
import ProfileSettings from "./ProfileSettings";
import SharedAccess from "./SharedAccess";
import LogsSettings from "./LogsSettings";
import SignInSettings from "./SignInSettings";
import { ApiKeys, ChangePassword, Devices, Passkeys, SignInHistory } from "./SecuritySettings";

const TABS = [
  { id: "profile", label: "Profile" },
  { id: "budget", label: "Budget" },
  { id: "notifications", label: "Notifications" },
  { id: "security", label: "Security" },
  { id: "api", label: "API keys" },
  { id: "email", label: "Email" },
  { id: "plaid", label: "Plaid" },
  { id: "ai", label: "AI" },
  { id: "data", label: "Data" },
  { id: "logs", label: "Logs" },
] as const;
type Tab = (typeof TABS)[number]["id"];

// "#/settings/security" -> "security"
const tabFromHash = (): Tab => {
  const t = window.location.hash.split("?")[0].split("/")[2];
  if (t === "signin") return "security"; // OAuth sign-in moved into Security
  return (TABS.find((x) => x.id === t)?.id ?? "profile") as Tab;
};

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>(tabFromHash);

  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className="mx-auto max-w-[760px] px-3 pb-16 pt-4 sm:px-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <nav aria-label="Settings sections" className="no-scrollbar -mx-3 mt-3 overflow-x-auto border-b border-line px-3 sm:mx-0 sm:px-0">
        <div role="tablist" className="flex min-w-max">
          {TABS.map((t) => (
            <a
              key={t.id}
              role="tab"
              href={`#/settings/${t.id}`}
              aria-selected={tab === t.id}
              className={`-mb-px border-b-[3px] px-3 py-2.5 text-sm font-semibold whitespace-nowrap ${
                tab === t.id ? "border-primary text-ink" : "border-transparent text-subtle hover:border-strong hover:text-ink"
              }`}
            >
              {t.label}
            </a>
          ))}
        </div>
      </nav>

      <div role="tabpanel" aria-label={TABS.find((t) => t.id === tab)!.label} className="mt-6 flex flex-col gap-6">
        {tab === "profile" && (
          <>
            <ProfileSettings />
            <ThemePicker />
            <SharedAccess />
          </>
        )}
        {tab === "budget" && <BudgetSettings />}
        {tab === "notifications" && <NotificationSettings />}
        {tab === "security" && (
          <>
            <ChangePassword />
            <Passkeys />
            <SignInSettings />
            <Devices />
            <SignInHistory />
          </>
        )}
        {tab === "api" && (
          <FeatureSwitch
            feature="apiKeys"
            title="API keys"
            text="Other apps (like n8n or a script) can use your budget with a key. Turn this off to refuse every key at once."
            offText="Off: every request made with a key is refused (and shows in Logs). Your keys are kept for when you turn this back on."
          >
            <ApiKeys />
          </FeatureSwitch>
        )}
        {tab === "email" && <EmailSettings />}
        {tab === "plaid" && (
          <FeatureSwitch
            feature="plaid"
            title="Bank syncing with Plaid"
            text="Connect your banks and import their transactions automatically."
            offText="Off: no bank syncing or connecting. Connected banks and their imported transactions stay, shown as paused on the Accounts page. Your Plaid keys are kept."
          >
            <PlaidSettings />
            <p className="px-1 text-subtle">
              Connect banks and see their balances on the <a href="#/accounts" className="font-semibold text-link hover:underline">Accounts</a> page.
            </p>
          </FeatureSwitch>
        )}
        {tab === "ai" && (
          <FeatureSwitch
            feature="ai"
            title="AI"
            text={<>Let AI suggest categories for your transactions. Choose when it's used with <a href="#/settings/budget" className="font-semibold text-link hover:underline">AI categorization</a> in Settings › Budget.</>}
            offText="Off: AI is never used. Your AI services are kept for when you turn this back on."
          >
            <AiSettings />
          </FeatureSwitch>
        )}
        {tab === "data" && (
          <>
            <DataSettings />
            <UpdatesSettings />
          </>
        )}
        {tab === "logs" && <LogsSettings />}
      </div>
    </div>
  );
}

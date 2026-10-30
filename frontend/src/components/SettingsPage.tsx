import { FeatureSwitch } from "./FeatureSwitch";
import ThemePicker from "./ThemePicker";
import { UpdatesSettings } from "./UpdateBar";
import { useEffect, useState } from "react";
import { canManage, useSession } from "../session";
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

// setup: the app's setup, hidden from a "user" (shared access; the server refuses it too)
const TABS = [
  { id: "profile", label: "Profile", setup: false },
  { id: "budget", label: "Budget", setup: false },
  { id: "notifications", label: "Notifications", setup: false },
  { id: "security", label: "Security", setup: false },
  { id: "api", label: "API keys", setup: true },
  { id: "email", label: "Email", setup: true },
  { id: "plaid", label: "Plaid", setup: true },
  { id: "ai", label: "AI", setup: true },
  { id: "data", label: "Data", setup: true },
  { id: "logs", label: "Logs", setup: true },
] as const;
type Tab = (typeof TABS)[number]["id"];

// "#/settings/security" -> "security" (a tab this person can't see opens Profile)
const tabFromHash = (tabs: readonly (typeof TABS)[number][]): Tab => {
  const t = window.location.hash.split("?")[0].split("/")[2];
  if (t === "signin") return "security"; // OAuth sign-in moved into Security
  return (tabs.find((x) => x.id === t)?.id ?? "profile") as Tab;
};

export default function SettingsPage() {
  const manage = canManage(useSession().user);
  const tabs = TABS.filter((t) => manage || !t.setup);
  const [tab, setTab] = useState<Tab>(() => tabFromHash(tabs));

  useEffect(() => {
    const onHash = () => setTab(tabFromHash(TABS.filter((t) => manage || !t.setup)));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [manage]);

  return (
    <div className="mx-auto max-w-[760px] px-3 pb-16 pt-4 sm:px-6">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <nav aria-label="Settings sections" className="no-scrollbar -mx-3 mt-3 overflow-x-auto border-b border-line px-3 sm:mx-0 sm:px-0">
        <div role="tablist" className="flex min-w-max">
          {tabs.map((t) => (
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
            {manage && <SignInSettings />}
            <Devices />
            <SignInHistory />
          </>
        )}
        {manage && tab === "api" && (
          <FeatureSwitch
            feature="apiKeys"
            title="API keys"
            text="Other apps (like n8n or a script) can use your budget with a key. Turn this off to refuse every key at once."
            offText="Off: every request made with a key is refused (and shows in Logs). Your keys are kept for when you turn this back on."
          >
            <ApiKeys />
          </FeatureSwitch>
        )}
        {manage && tab === "email" && <EmailSettings />}
        {manage && tab === "plaid" && (
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
        {manage && tab === "ai" && (
          <FeatureSwitch
            feature="ai"
            title="AI"
            text={<>Let AI suggest categories for your transactions. Choose when it's used with <a href="#/settings/budget" className="font-semibold text-link hover:underline">AI categorization</a> in Settings › Budget.</>}
            offText="Off: AI is never used. Your AI services are kept for when you turn this back on."
          >
            <AiSettings />
          </FeatureSwitch>
        )}
        {manage && tab === "data" && (
          <>
            <DataSettings />
            <UpdatesSettings />
          </>
        )}
        {manage && tab === "logs" && <LogsSettings />}
      </div>
    </div>
  );
}

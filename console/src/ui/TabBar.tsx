import type { Tab } from '../store';
import { tabKey } from '../store';

interface TabBarProps {
  tabs: readonly Tab[];
  activeKey: string | null;
  onSelect: (key: string) => void;
  onClose: (sessionId: string) => void;
  onNew: () => void;
}

/** The tab strip: one tab per session/agent, a close button each, plus "＋ New". */
export function TabBar({ tabs, activeKey, onSelect, onClose, onNew }: TabBarProps) {
  return (
    <div class="tab-bar" role="tablist">
      {tabs.map((tab) => {
        const key = tabKey(tab);
        return (
          <div
            key={key}
            class={`tab${key === activeKey ? ' active' : ''}`}
            role="tab"
            aria-selected={key === activeKey}
            data-testid={`tab-${key}`}
            onClick={() => onSelect(key)}
          >
            <span class="tab-label">{tab.label}</span>
            <button
              class="tab-close"
              aria-label={`Terminate ${tab.label}`}
              data-testid={`close-${tab.sessionId}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.sessionId);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button class="tab-new" data-testid="new-session" onClick={onNew}>
        ＋ New
      </button>
    </div>
  );
}

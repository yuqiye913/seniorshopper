import type { UIContext } from '@midscene/core';
import { overrideAIConfig } from '@midscene/shared/env';
import {
  type PlaygroundResult,
  PlaygroundResultView,
  type ReplayScriptsInfo,
  useEnvConfig,
} from '@midscene/visualizer';
import { allScriptsFromDump } from '@midscene/visualizer';
import { Button, Card, Form, Input, message, Space, Alert } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import './SeniorShopper.less';

export interface SeniorShopperProps {
  getAgent: (forceSameTabNavigation?: boolean) => any | null;
  showContextPreview?: boolean;
  dryMode?: boolean;
}

// Blank result template
const blankResult = {
  result: null,
  dump: null,
  reportHTML: null,
  error: null,
};

// SeniorShopper Component - Simplified version with just one action type
export function SeniorShopper({
  getAgent,
  showContextPreview = true,
  dryMode = false,
}: SeniorShopperProps) {
  // State management
  const [loading, setLoading] = useState(false);
  const [loadingProgressText, setLoadingProgressText] = useState('');
  const [result, setResult] = useState<PlaygroundResult | null>(null);
  const [replayScriptsInfo, setReplayScriptsInfo] = useState<ReplayScriptsInfo | null>(null);
  const [replayCounter, setReplayCounter] = useState(0);
  const [isChromePage, setIsChromePage] = useState(false);

  // Form and environment configuration
  const [form] = Form.useForm();
  const { config, deepThink } = useEnvConfig();
  const forceSameTabNavigation = useEnvConfig((state) => state.forceSameTabNavigation);

  // References
  const currentAgentRef = useRef<any>(null);
  const currentRunningIdRef = useRef<number | null>(0);
  const interruptedFlagRef = useRef<Record<number, boolean>>({});

  // Environment configuration check
  const configAlreadySet = Object.keys(config || {}).length >= 1;

  // Check if we're on a chrome:// page
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const currentUrl = tabs[0]?.url || '';
      setIsChromePage(currentUrl.startsWith('chrome://'));
    });
  }, []);

  // Override AI configuration
  useEffect(() => {
    overrideAIConfig(config);
  }, [config]);

  // Cleanup function to properly release resources
  const cleanup = async () => {
    try {
      if (currentAgentRef.current?.page) {
        await currentAgentRef.current.page.destroy();
      }
      currentAgentRef.current = null;
    } catch (e) {
      console.error('Cleanup error:', e);
    }
  };

  // Ensure cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, []);

  const resetResult = () => {
    setResult(null);
    setLoading(false);
    setReplayScriptsInfo(null);
  };

  // Handle form submission
  const handleRun = useCallback(async () => {
    if (isChromePage) {
      message.error('Please use Midscene on a regular webpage (http://, https://, or file://)');
      return;
    }

    const value = form.getFieldsValue();
    if (!value.prompt) {
      message.error('Please enter what you want to shop for');
      return;
    }

    // Clean up previous session if exists
    await cleanup();

    setLoading(true);
    setResult(null);
    const result: PlaygroundResult = { ...blankResult };

    const activeAgent = getAgent(forceSameTabNavigation);
    const thisRunningId = Date.now();
    try {
      if (!activeAgent) {
        throw new Error('No agent found');
      }
      currentAgentRef.current = activeAgent;
      currentRunningIdRef.current = thisRunningId;
      interruptedFlagRef.current[thisRunningId] = false;

      // Only use aiAction for shopping
      result.result = await activeAgent?.aiAction(value.prompt);
    } catch (e: any) {
      result.error = e?.message || 'An error occurred while shopping';
      console.error(e);
    }

    if (interruptedFlagRef.current[thisRunningId]) {
      await cleanup();
      return;
    }

    try {
      result.dump = activeAgent?.dumpDataString()
        ? JSON.parse(activeAgent.dumpDataString())
        : null;
      result.reportHTML = activeAgent?.reportHTMLString() || null;
    } catch (e) {
      console.error(e);
    }

    // Clean up after action is complete
    await cleanup();

    setResult(result);
    setLoading(false);
    if (result?.dump) {
      const info = allScriptsFromDump(result.dump);
      setReplayScriptsInfo(info);
      setReplayCounter((c) => c + 1);
    } else {
      setReplayScriptsInfo(null);
    }
  }, [form, getAgent, forceSameTabNavigation, isChromePage]);

  const handleStop = async () => {
    const thisRunningId = currentRunningIdRef.current;
    if (thisRunningId) {
      interruptedFlagRef.current[thisRunningId] = true;
      await cleanup();
      resetResult();
    }
  };

  const runButtonEnabled = !!getAgent && configAlreadySet && !isChromePage;
  const stoppable = !dryMode && loading;

  return (
    <div className="senior-shopper">
      <Card title="SeniorShopper Assistant" className="shopper-card">
        {isChromePage && (
          <Alert
            message="Cannot use on Chrome pages"
            description="Please navigate to a regular webpage (http://, https://, or file://) to use Midscene."
            type="warning"
            showIcon
            style={{ marginBottom: '16px' }}
          />
        )}
        <Form form={form} layout="vertical">
          <Form.Item name="prompt" label="What would you like to shop for?">
            <Input.TextArea 
              rows={4}
              placeholder="Describe what you want to buy or find on this shopping website..." 
              disabled={isChromePage}
            />
          </Form.Item>

          <Space>
            <Button
              type="primary"
              onClick={handleRun}
              disabled={!runButtonEnabled || loading}
              loading={loading}
            >
              Start Shopping
            </Button>
            {stoppable && (
              <Button onClick={handleStop}>
                Stop
              </Button>
            )}
          </Space>
        </Form>

        {loading && (
          <div className="loading-indicator">
            {loadingProgressText || 'Searching for your items...'}
          </div>
        )}

        <div className="result-section">
          <PlaygroundResultView
            result={result}
            loading={loading}
            serviceMode="In-Browser-Extension"
            replayScriptsInfo={replayScriptsInfo}
            replayCounter={replayCounter}
            loadingProgressText={loadingProgressText}
          />
        </div>
      </Card>
    </div>
  );
} 
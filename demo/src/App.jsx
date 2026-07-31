import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Actions,
  Attachments,
  Bubble,
  Conversations,
  Prompts,
  Sender,
  Welcome,
} from "@ant-design/x";
import { XMarkdown } from "@ant-design/x-markdown";
import {
  Alert,
  Button,
  Drawer,
  Dropdown,
  Empty,
  Image,
  Input,
  Modal,
  Progress,
  Segmented,
  Select,
  Tag,
  Tooltip,
  Typography,
  message as toast,
} from "antd";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  Bot,
  Brain,
  CircleAlert,
  Copy,
  Database,
  Download,
  Ellipsis,
  FileImage,
  FileText,
  Gauge,
  Link2,
  LoaderCircle,
  Menu,
  MessageSquareQuote,
  PanelRight,
  Plus,
  Pencil,
  Quote,
  RefreshCw,
  RotateCcw,
  Search,
  X,
} from "lucide-react";
import {
  activeRunStageLabel,
  buildConversationWorkspace,
  buildGatewayReachabilityCopy,
  buildMessageWindow,
  buildMessagePreview,
  buildRunFailureCopy,
  canSubmitRun,
  conversationStatusLabel,
  deserializeConversationDrafts,
  extractMarkdownHeadings,
  insertLatestRunFailure,
  isMessageListAtLatest,
  isSafeMarkdownHref,
  readGatewayModels,
  readConversationDraft,
  recoverRunInput,
  scrollMessageListToLatest as scrollReadyMessageListToLatest,
  serializeConversationDrafts,
  storeConversationDraft,
} from "./conversation-view-model.js";
import ConversationAnchorRail from "./conversation-anchor-rail.jsx";
import { runtimeAdapter } from "./runtime-adapter.js";

const { Text, Title } = Typography;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REFERENCES = 3;
const CONVERSATION_PAGE_SIZE = 40;
const MESSAGE_PAGE_SIZE = 80;
const DRAFT_STORAGE_KEY = "ai-platform:c1:conversation-drafts:v1";

let workspaceInitializationPromise = null;

/** 只执行一次初始事实读取，避免 React StrictMode 在开发模式重复创建空会话。 */
function initializeWorkspace() {
  if (!workspaceInitializationPromise) workspaceInitializationPromise = loadInitialWorkspace();
  return workspaceInitializationPromise;
}

/** 读取本地会话事实；没有会话时创建唯一初始会话。 */
async function loadInitialWorkspace() {
  const initialConversations = await runtimeAdapter.listConversations();
  const conversations = [...initialConversations];
  if (conversations.length === 0) conversations.push(await runtimeAdapter.createConversation());
  const conversation = await runtimeAdapter.getConversation(conversations[0].id);
  return { conversations, conversation };
}

/** 网关不可用时保留渠道页面与本地会话能力，并返回可展示的失败状态。 */
async function loadGatewayStatusSafely() {
  try {
    return await runtimeAdapter.getGatewayStatus();
  } catch (error) {
    return { ok: false, error: error.message, model: "-", models: [], gatewayBaseUrl: "-" };
  }
}

/** 从当前标签页的 sessionStorage 读取渠道草稿；不可用时退化为空集合。 */
function loadStoredConversationDrafts() {
  try {
    return deserializeConversationDrafts(globalThis.sessionStorage?.getItem(DRAFT_STORAGE_KEY));
  } catch {
    return new Map();
  }
}

/** AI 应用基础平台 C1 渠道工作台。 */
export default function App() {
  const [toastApi, toastContext] = toast.useMessage();
  const [gateway, setGateway] = useState(null);
  const [conversations, setConversations] = useState([]);
  const [currentConversationId, setCurrentConversationId] = useState(null);
  const [conversation, setConversation] = useState(null);
  const [composerValue, setComposerValue] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [references, setReferences] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [initializing, setInitializing] = useState(true);
  const [gatewayChecking, setGatewayChecking] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [runError, setRunError] = useState("");
  const [lastLatency, setLastLatency] = useState(null);
  const [conversationQuery, setConversationQuery] = useState("");
  const [conversationFilter, setConversationFilter] = useState("active");
  const [conversationLimit, setConversationLimit] = useState(CONVERSATION_PAGE_SIZE);
  const [messageLimit, setMessageLimit] = useState(MESSAGE_PAGE_SIZE);
  const [pendingRecovery, setPendingRecovery] = useState(null);
  const [renameDraft, setRenameDraft] = useState({ open: false, conversation: null, value: "", error: "" });
  const [conversationDrawerOpen, setConversationDrawerOpen] = useState(false);
  const [contextDrawerOpen, setContextDrawerOpen] = useState(false);
  const [contextExpanded, setContextExpanded] = useState(false);
  const [isFollowingLatest, setIsFollowingLatest] = useState(true);
  const [unseenMessageCount, setUnseenMessageCount] = useState(0);
  const [linkDraft, setLinkDraft] = useState({ open: false, type: "document", value: "", error: "" });
  const attachmentComponentRef = useRef(null);
  const messageListRef = useRef(null);
  const composerValueRef = useRef("");
  const attachmentFactsRef = useRef([]);
  const referenceFactsRef = useRef([]);
  const selectedModelRef = useRef("");
  const conversationDraftsRef = useRef(loadStoredConversationDrafts());
  const visibleMessageCountRef = useRef({ conversationId: null, count: 0 });
  const activeRunRef = useRef(null);
  const cancelRequestedRef = useRef(false);

  // 首次挂载时复用唯一初始化 Promise，并忽略卸载后的异步结果。
  useEffect(() => {
    let disposed = false;
    /** 把初始网关、会话列表和当前事实装入页面状态。 */
    async function applyInitialWorkspace() {
      try {
        const data = await initializeWorkspace();
        if (disposed) return;
        setConversations(data.conversations);
        setCurrentConversationId(data.conversation.id);
        setConversation(data.conversation);
        restoreConversationDraft(data.conversation.id);
        void refreshGatewayStatus();
      } catch (error) {
        if (!disposed) setRunError(error.message);
      } finally {
        if (!disposed) setInitializing(false);
      }
    }
    void applyInitialWorkspace();
    /** 标记本次 effect 已卸载，避免延迟网络结果写入旧组件。 */
    return function disposeInitialization() {
      disposed = true;
    };
  }, []);

  // 顶层统一处理会话搜索和新建快捷键，避免桌面与移动面板重复响应。
  useEffect(() => {
    /** 聚焦当前可见会话搜索框，或在允许时创建新会话。 */
    function handleWorkspaceShortcut(event) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        const inputs = document.querySelectorAll("[data-conversation-search]");
        for (const input of inputs) {
          if (input.offsetParent !== null) {
            input.focus();
            break;
          }
        }
        return;
      }
      if (event.shiftKey && event.key.toLocaleLowerCase() === "o" && !activeRunRef.current) {
        event.preventDefault();
        void handleCreateConversation();
      }
    }
    document.addEventListener("keydown", handleWorkspaceShortcut);
    /** 卸载页面时移除全局快捷键监听。 */
    return function disposeWorkspaceShortcut() {
      document.removeEventListener("keydown", handleWorkspaceShortcut);
    };
  }, [currentConversationId]);

  // 当前会话变化时重建事实 SSE，并合并短时间内的事件刷新。
  useEffect(() => {
    if (!currentConversationId) return undefined;
    let refreshTimer = null;
    let disposed = false;

    /** 从 SQLite API 同步当前会话与会话列表。 */
    async function refreshFromFactEvent() {
      if (disposed || activeRunRef.current?.conversationId === currentConversationId) return;
      try {
        const [detail, items] = await Promise.all([
          runtimeAdapter.getConversation(currentConversationId),
          runtimeAdapter.listConversations(),
        ]);
        if (!disposed) {
          setConversation(detail);
          setConversations(items);
        }
      } catch (error) {
        if (!disposed) setRunError(error.message);
      }
    }

    /** 合并相邻事实事件，避免一轮 Run 的多条日志触发重复详情请求。 */
    function scheduleFactRefresh() {
      if (activeRunRef.current?.conversationId === currentConversationId) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshFromFactEvent, 120);
    }

    /** EventSource 会自动重连，页面只在载荷解析错误时给出非阻断提示。 */
    function handleFactStreamError(error) {
      if (error instanceof SyntaxError) setRunError("会话事实事件格式无效");
    }

    const subscription = runtimeAdapter.subscribeConversation(currentConversationId, {
      onEvent: scheduleFactRefresh,
      onError: handleFactStreamError,
    });
    /** 关闭旧会话订阅和未执行的合并刷新。 */
    return function disposeSubscription() {
      disposed = true;
      clearTimeout(refreshTimer);
      subscription.close();
    };
  }, [currentConversationId]);

  /** 同步 React 与 ref 中的 Sender 正文，供异步会话切换读取最新草稿。 */
  function setComposerFact(next) {
    const normalized = String(next || "");
    composerValueRef.current = normalized;
    setComposerValue(normalized);
  }

  /** 同步 React 与 ref 中的附件事实，供并发 FileReader 回调稳定追加。 */
  function setAttachmentFacts(next) {
    attachmentFactsRef.current = next;
    setAttachments(next);
  }

  /** 同步 React 与 ref 中的引用事实，保证发送载荷只取当前队列。 */
  function setReferenceFacts(next) {
    referenceFactsRef.current = next;
    setReferences(next);
  }

  /** 同步 React 与 ref 中的当前模型别名，保证异步发送读取的是已确认选择。 */
  function setSelectedModelFact(next) {
    const normalized = String(next || "").trim();
    selectedModelRef.current = normalized;
    setSelectedModel(normalized);
  }

  /** 将渠道草稿集合写入当前标签页，序列化层会过滤本地图片 data URL。 */
  function persistConversationDrafts() {
    try {
      globalThis.sessionStorage?.setItem(
        DRAFT_STORAGE_KEY,
        serializeConversationDrafts(conversationDraftsRef.current),
      );
    } catch {
      // 浏览器禁用存储或达到配额时仍保留当前页面内存草稿。
    }
  }

  /** 在网关可见别名中保留当前选择，不可用时回退默认或第一个别名。 */
  function resolveSelectedModel(nextGateway, requestedModel = selectedModelRef.current) {
    const models = readGatewayModels(nextGateway);
    const requested = String(requestedModel || "").trim();
    if (models.includes(requested)) return requested;
    const defaultModel = String(nextGateway?.model || "").trim();
    return models.includes(defaultModel) ? defaultModel : models[0] || "";
  }

  /** 保存当前会话尚未发送的渠道草稿；空草稿会清理旧快照。 */
  function saveCurrentConversationDraft() {
    conversationDraftsRef.current = storeConversationDraft(
      conversationDraftsRef.current,
      currentConversationId,
      {
        value: composerValueRef.current,
        attachments: attachmentFactsRef.current,
        references: referenceFactsRef.current,
        model: selectedModelRef.current,
      },
    );
    persistConversationDrafts();
  }

  /** 恢复目标会话的独立渠道草稿，不把其他会话输入带入当前 Sender。 */
  function restoreConversationDraft(conversationId, nextGateway = gateway) {
    const draft = readConversationDraft(conversationDraftsRef.current, conversationId);
    setComposerFact(draft.value);
    setAttachmentFacts(draft.attachments);
    setReferenceFacts(draft.references);
    setSelectedModelFact(resolveSelectedModel(nextGateway, draft.model));
  }

  /** 删除指定会话已经发送或主动结束的渠道草稿。 */
  function clearConversationDraft(conversationId) {
    conversationDraftsRef.current = storeConversationDraft(
      conversationDraftsRef.current,
      conversationId,
      { value: "", attachments: [], references: [], model: selectedModelRef.current },
    );
    persistConversationDrafts();
  }

  // 输入变化时持续保存当前会话草稿；本地图片只保留在内存 Map 中。
  useEffect(() => {
    if (!currentConversationId) return;
    conversationDraftsRef.current = storeConversationDraft(
      conversationDraftsRef.current,
      currentConversationId,
      {
        value: composerValue,
        attachments,
        references,
        model: selectedModel,
      },
    );
    persistConversationDrafts();
  }, [currentConversationId, composerValue, attachments, references, selectedModel]);

  /** 同步 React 与 ref 中的活动 Run，供事实 SSE effect 读取最新生成状态。 */
  function setActiveRunFact(next) {
    activeRunRef.current = next;
    setActiveRun(next);
  }

  /** 在当前活动 Run 上合并局部状态，Run 已收口时忽略迟到增量。 */
  function patchActiveRun(patch) {
    const current = activeRunRef.current;
    if (!current) return;
    setActiveRunFact({ ...current, ...patch });
  }

  /** 重新检查模型网关，并按用户主动触发与后台刷新区分提示。 */
  async function refreshGatewayStatus({ announce = false } = {}) {
    setGatewayChecking(true);
    const next = await loadGatewayStatusSafely();
    setGateway(next);
    setSelectedModelFact(resolveSelectedModel(next));
    setGatewayChecking(false);
    if (announce) {
      const copy = buildGatewayReachabilityCopy(next);
      if (next.ok) toastApi.success(copy.announcement);
      else toastApi.warning(copy.announcement);
    }
    return next;
  }

  /** 响应用户的网关重新检测命令。 */
  function handleRefreshGateway() {
    void refreshGatewayStatus({ announce: true });
  }

  /** 选择会话并读取服务端完整事实；生成期间保持当前 Run 视图稳定。 */
  async function handleConversationChange(conversationId) {
    if (activeRunRef.current || conversationId === currentConversationId) return;
    saveCurrentConversationDraft();
    setCurrentConversationId(conversationId);
    setConversation(null);
    setRunError("");
    restoreConversationDraft(conversationId);
    setIsFollowingLatest(true);
    setUnseenMessageCount(0);
    setMessageLimit(MESSAGE_PAGE_SIZE);
    setPendingRecovery(null);
    setConversationDrawerOpen(false);
    try {
      setConversation(await runtimeAdapter.getConversation(conversationId));
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 创建新的服务端会话并立即切换，不在浏览器生成虚拟会话事实。 */
  async function handleCreateConversation() {
    if (activeRunRef.current) return;
    saveCurrentConversationDraft();
    try {
      const created = await runtimeAdapter.createConversation();
      const items = await runtimeAdapter.listConversations();
      setConversations(items);
      setCurrentConversationId(created.id);
      setConversation(created);
      restoreConversationDraft(created.id);
      setIsFollowingLatest(true);
      setUnseenMessageCount(0);
      setMessageLimit(MESSAGE_PAGE_SIZE);
      setPendingRecovery(null);
      setConversationDrawerOpen(false);
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 更新会话搜索词并把渐进窗口重置到首批。 */
  function handleConversationQueryChange(event) {
    setConversationQuery(event.target.value);
    setConversationLimit(CONVERSATION_PAGE_SIZE);
  }

  /** 更新归档筛选并把渐进窗口重置到首批。 */
  function handleConversationFilterChange(value) {
    setConversationFilter(value);
    setConversationLimit(CONVERSATION_PAGE_SIZE);
  }

  /** 为会话列表追加下一批摘要。 */
  function handleLoadMoreConversations() {
    setConversationLimit(conversationLimit + CONVERSATION_PAGE_SIZE);
  }

  /** 打开受控重命名对话框，标题仍由 Runtime 校验并持久化。 */
  function handleOpenConversationRename(item) {
    if (activeRunRef.current) return;
    setRenameDraft({ open: true, conversation: item, value: item.title || "", error: "" });
  }

  /** 更新重命名输入并清除旧校验错误。 */
  function handleConversationRenameChange(event) {
    setRenameDraft({ ...renameDraft, value: event.target.value, error: "" });
  }

  /** 关闭会话重命名对话框。 */
  function closeConversationRename() {
    setRenameDraft({ open: false, conversation: null, value: "", error: "" });
  }

  /** 提交标题更新并用服务端返回事实刷新当前详情和摘要列表。 */
  async function confirmConversationRename() {
    const title = renameDraft.value.trim();
    if (!title || title.length > 80) {
      setRenameDraft({ ...renameDraft, error: "标题需为 1-80 个字符" });
      return;
    }
    try {
      const updated = await runtimeAdapter.updateConversation(renameDraft.conversation.id, { title });
      const items = await runtimeAdapter.listConversations();
      setConversations(items);
      if (updated.id === currentConversationId) setConversation(updated);
      closeConversationRename();
      toastApi.success("会话标题已更新");
    } catch (error) {
      setRenameDraft({ ...renameDraft, error: error.message });
    }
  }

  /** 切换独立归档状态，不改变 active/closed 生命周期。 */
  async function handleConversationArchive(item) {
    if (activeRunRef.current) return;
    try {
      const archived = !item.archivedAt;
      const updated = await runtimeAdapter.updateConversation(item.id, { archived });
      const items = await runtimeAdapter.listConversations();
      setConversations(items);
      if (updated.id === currentConversationId) setConversation(updated);
      toastApi.success(archived ? "会话已归档" : "会话已取消归档");
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 请求 Runtime 完成 checkpoint 并关闭当前会话。 */
  async function closeCurrentConversation() {
    try {
      const result = await runtimeAdapter.closeConversation(currentConversationId);
      const [detail, items] = await Promise.all([
        runtimeAdapter.getConversation(result.conversation.id),
        runtimeAdapter.listConversations(),
      ]);
      setConversation(detail);
      setConversations(items);
      clearConversationDraft(currentConversationId);
      setComposerFact("");
      setAttachmentFacts([]);
      setReferenceFacts([]);
      toastApi.success("会话已结束");
    } catch (error) {
      setRunError(error.message);
    }
  }

  /** 打开关闭确认，避免误触造成会话永久拒绝新 Run。 */
  function handleCloseConversation() {
    if (!conversation || conversation.status !== "active" || activeRunRef.current) return;
    Modal.confirm({
      title: "结束当前会话？",
      content: "结束后将完成最终记忆 checkpoint，已持久化消息会保留。",
      okText: "结束会话",
      cancelText: "取消",
      onOk: closeCurrentConversation,
    });
  }

  /** 更新受控 Sender 文本。 */
  function handleComposerChange(value) {
    setComposerFact(value);
  }

  /** 更新当前会话 Sender 使用的模型别名，活动 Run 期间保持选择不可变。 */
  function handleModelChange(value) {
    if (activeRunRef.current) return;
    setSelectedModelFact(value);
  }

  /** 将选中的建议填入 Sender，仍由用户决定是否发送。 */
  function handlePromptClick({ data }) {
    setComposerFact(data.label);
  }

  /** 将一条已持久化消息加入当前发送引用队列，最多保留三条。 */
  function handleQuoteMessage(message) {
    if (
      !message?.id ||
      String(message.id).startsWith("optimistic:") ||
      String(message.id).startsWith("streaming:")
    ) return;
    for (const reference of referenceFactsRef.current) {
      if (reference.messageId === message.id) return;
    }
    if (referenceFactsRef.current.length >= MAX_REFERENCES) {
      toastApi.warning(`最多引用 ${MAX_REFERENCES} 条消息`);
      return;
    }
    setReferenceFacts([
      ...referenceFactsRef.current,
      {
        type: "conversation_message",
        messageId: message.id,
        role: message.role,
        preview: buildMessagePreview(message.displayContent),
      },
    ]);
  }

  /** 按稳定 messageId 从当前发送引用队列移除一项。 */
  function handleRemoveReference(messageId) {
    const next = [];
    for (const reference of referenceFactsRef.current) {
      if (reference.messageId !== messageId) next.push(reference);
    }
    setReferenceFacts(next);
  }

  /** 用服务端消息事实恢复 Run 的正文、附件和引用，生成新 Run 时再创建新幂等标识。 */
  function restoreRunInput(sourceMessageId, sourceRunId, recoveryMode) {
    const sourceMessage = conversation?.messages?.find(
      // 恢复只认稳定 messageId，不能从失败提示里的展示文本反推输入。
      (message) => message.id === sourceMessageId,
    );
    if (!sourceMessage) {
      toastApi.error("未找到失败 Run 对应的用户消息");
      return;
    }
    const recovered = recoverRunInput(sourceMessage);
    const recoveredAttachments = buildRecoveredAttachments(recovered.imageUrls, recovered.documentUrls);
    const recoveredReferences = buildRecoveredReferences(recovered.references, conversation.messages);
    setComposerFact(recovered.message);
    setAttachmentFacts(recoveredAttachments);
    setReferenceFacts(recoveredReferences);
    setPendingRecovery({ sourceRunId, recoveryMode });
    setRunError("");
    toastApi.success("原输入已恢复，可调整后重新发送");
  }

  /** 恢复失败输入前保护当前草稿，避免覆盖用户尚未发送的内容。 */
  function handleEditRecoveryInput(sourceMessageId, sourceRunId, recoveryMode = "retry") {
    const hasDraft = Boolean(composerValue.trim() || attachments.length > 0 || references.length > 0);
    if (!hasDraft) {
      restoreRunInput(sourceMessageId, sourceRunId, recoveryMode);
      return;
    }
    Modal.confirm({
      title: "覆盖当前草稿？",
      content: "恢复失败 Run 的输入会替换当前正文、附件和引用。",
      okText: "恢复输入",
      cancelText: "保留草稿",
      /** 用户确认后才覆盖当前渠道草稿。 */
      onOk() {
        restoreRunInput(sourceMessageId, sourceRunId, recoveryMode);
      },
    });
  }

  /** 取消待发送输入与历史 Run 的恢复关系，不清空用户已经编辑的草稿。 */
  function clearPendingRecovery() {
    setPendingRecovery(null);
  }

  /** 从指定历史 Run 的持久化用户消息构造新的恢复 Run 载荷。 */
  function buildRecoveryRunPayload(sourceRunId, recoveryMode) {
    const sourceMessage = conversation?.messages?.find(
      // 重新执行必须读取服务端稳定用户消息，不能从助手展示文本反推原请求。
      (message) => message.runId === sourceRunId && message.role === "user",
    );
    if (!sourceMessage) return null;
    const recovered = recoverRunInput(sourceMessage);
    return buildRunPayload(
      recovered.message,
      buildRecoveredAttachments(recovered.imageUrls, recovered.documentUrls),
      buildRecoveredReferences(recovered.references, conversation.messages),
      selectedModelRef.current,
      { sourceRunId, recoveryMode },
    );
  }

  /** 直接重试失败 Run，并完整保留当前尚未发送的草稿。 */
  function handleRetryRun(sourceRunId) {
    const payload = buildRecoveryRunPayload(sourceRunId, "retry");
    if (!payload) {
      toastApi.error("未找到失败 Run 对应的用户消息");
      return;
    }
    void executeRun(payload, { preserveDraft: true });
  }

  /** 重新生成已完成 Run，并完整保留当前尚未发送的草稿。 */
  function handleRegenerateRun(sourceRunId) {
    const payload = buildRecoveryRunPayload(sourceRunId, "regenerate");
    if (!payload) {
      toastApi.error("未找到已完成 Run 对应的用户消息");
      return;
    }
    void executeRun(payload, { preserveDraft: true });
  }

  /** 用显式用户输入继续已取消 Run，不尝试 Token 级断点续传。 */
  function handleContinueRun(sourceRunId) {
    const payload = buildRunPayload(
      "请从上次中断处继续回答，避免重复已经生成的内容。",
      [],
      [],
      selectedModelRef.current,
      { sourceRunId, recoveryMode: "continue" },
    );
    void executeRun(payload, { preserveDraft: true });
  }

  /** 触发 Ant Design X Attachments 的隐藏图片选择器。 */
  function openImagePicker() {
    attachmentComponentRef.current?.select({ accept: "image/*", multiple: true });
  }

  /** 根据附件菜单动作打开图片选择器或 URL 输入框。 */
  function handleAttachmentMenuClick({ key }) {
    if (key === "upload-image") {
      openImagePicker();
      return;
    }
    setLinkDraft({ open: true, type: key === "image-url" ? "image" : "document", value: "", error: "" });
  }

  /** 校验本地图片并转换为 Runtime 已支持的 data URL。 */
  async function handleBeforeUpload(file) {
    if (!file.type.startsWith("image/")) {
      toastApi.error("只能上传图片文件");
      return false;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toastApi.error("单张图片不能超过 5 MB");
      return false;
    }
    if (countImageAttachments(attachmentFactsRef.current) >= MAX_IMAGES) {
      toastApi.warning(`最多添加 ${MAX_IMAGES} 张图片`);
      return false;
    }
    if (attachmentFactsRef.current.length >= MAX_ATTACHMENTS) {
      toastApi.warning(`最多添加 ${MAX_ATTACHMENTS} 个附件`);
      return false;
    }
    const url = await readFileAsDataUrl(file);
    setAttachmentFacts([
      ...attachmentFactsRef.current,
      {
        uid: crypto.randomUUID(),
        name: file.name,
        status: "done",
        type: file.type,
        size: file.size,
        url,
        thumbUrl: url,
        cardType: "image",
        kind: "image",
      },
    ]);
    return false;
  }

  /** 将粘贴的图片逐个交给同一附件校验流程。 */
  function handlePasteFiles(files) {
    for (const file of files) void handleBeforeUpload(file);
  }

  /** 按 Attachments 的 uid 移除受控附件。 */
  function handleRemoveAttachment(item) {
    const next = [];
    for (const attachment of attachmentFactsRef.current) {
      if (attachment.uid !== item.uid) next.push(attachment);
    }
    setAttachmentFacts(next);
    return true;
  }

  /** 更新 URL 附件输入值并清除旧校验错误。 */
  function handleLinkDraftChange(event) {
    setLinkDraft({ ...linkDraft, value: event.target.value, error: "" });
  }

  /** 关闭 URL 附件输入框并清空暂存值。 */
  function closeLinkDraft() {
    setLinkDraft({ open: false, type: "document", value: "", error: "" });
  }

  /** 校验并添加 http(s) 图片或文档链接附件。 */
  function confirmLinkDraft() {
    const url = linkDraft.value.trim();
    if (!isHttpUrl(url)) {
      setLinkDraft({ ...linkDraft, error: "请输入有效的 http(s) URL" });
      return;
    }
    if (attachmentFactsRef.current.length >= MAX_ATTACHMENTS) {
      setLinkDraft({ ...linkDraft, error: `最多添加 ${MAX_ATTACHMENTS} 个附件` });
      return;
    }
    if (linkDraft.type === "image" && countImageAttachments(attachmentFactsRef.current) >= MAX_IMAGES) {
      setLinkDraft({ ...linkDraft, error: `最多添加 ${MAX_IMAGES} 张图片` });
      return;
    }
    setAttachmentFacts([
      ...attachmentFactsRef.current,
      {
        uid: crypto.randomUUID(),
        name: readableUrlName(url),
        status: "done",
        url,
        thumbUrl: linkDraft.type === "image" ? url : undefined,
        cardType: linkDraft.type === "image" ? "image" : "file",
        kind: linkDraft.type,
        description: linkDraft.type === "image" ? "图片链接" : "文档链接",
      },
    ]);
    closeLinkDraft();
  }

  /** 调用显式取消端点；失败时保留 Run 视图并允许再次停止。 */
  async function cancelKnownRun(conversationId, runId) {
    try {
      await runtimeAdapter.cancelRun(conversationId, runId);
    } catch (error) {
      cancelRequestedRef.current = false;
      patchActiveRun({ status: "running" });
      setRunError(`停止生成失败：${error.message}`);
    }
  }

  /** 标记用户停止意图；尚无 runId 时等待 run-started 后立即取消。 */
  function handleCancelGeneration() {
    const run = activeRunRef.current;
    if (!run || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    patchActiveRun({ status: "stopping" });
    if (run.runId) void cancelKnownRun(run.conversationId, run.runId);
  }

  /** 执行一个已经归一化的 Run 载荷，并按选项保留用户当前草稿。 */
  async function executeRun(payload, { preserveDraft = false } = {}) {
    const current = conversation;
    if (!current || current.status !== "active" || activeRunRef.current) return;
    if (gateway?.ok !== true) {
      toastApi.warning("模型网关不可达，请重新检测后再发送");
      return;
    }
    if (!selectedModelRef.current) {
      toastApi.warning("当前没有可用模型，请重新检测模型网关");
      return;
    }
    if (!hasRunInput(payload)) return;

    const startedAt = performance.now();
    const optimisticUser = buildOptimisticUserMessage(current.id, payload);
    const runState = {
      conversationId: current.id,
      requestId: payload.requestId,
      runId: null,
      status: "starting",
      model: payload.model,
      partialText: "",
      optimisticUser,
    };
    cancelRequestedRef.current = false;
    setActiveRunFact(runState);
    setRunError("");
    if (!preserveDraft) {
      clearConversationDraft(current.id);
      setComposerFact("");
      setAttachmentFacts([]);
      setReferenceFacts([]);
      setPendingRecovery(null);
    } else {
      saveCurrentConversationDraft();
    }

    /** 接收稳定 runId，并补偿 run-started 前已经点击的停止意图。 */
    function handleRunStarted(event) {
      patchActiveRun({ runId: event.runId, status: cancelRequestedRef.current ? "stopping" : "running" });
      if (cancelRequestedRef.current) void cancelKnownRun(current.id, event.runId);
    }

    /** 将模型增量追加到单个乐观助手消息。 */
    function handleTextDelta(delta) {
      const run = activeRunRef.current;
      if (!run || run.conversationId !== current.id) return;
      patchActiveRun({ partialText: `${run.partialText}${delta}`, status: "running" });
    }

    /** 根据服务端工具事实更新回答附近阶段，工具结束后继续等待模型组织结果。 */
    function handleToolEvent(event) {
      const run = activeRunRef.current;
      if (!run || run.conversationId !== current.id) return;
      if (event.event === "tool-started") {
        patchActiveRun({ status: "tool-running", toolTitle: event.title || event.toolName });
        return;
      }
      patchActiveRun({ status: "running", toolTitle: "" });
    }

    /** 把 SSE 取消终止阶段映射为 UI 中的停止状态，最终仍由详情事实覆盖。 */
    function handleCancelled() {
      patchActiveRun({ status: "cancelled" });
    }

    try {
      const terminal = await runtimeAdapter.runConversationStream(current.id, payload, {
        onRunStarted: handleRunStarted,
        onToolEvent: handleToolEvent,
        onTextDelta: handleTextDelta,
        onCancelled: handleCancelled,
      });
      const [detail, items] = await Promise.all([
        runtimeAdapter.getConversation(current.id),
        runtimeAdapter.listConversations(),
      ]);
      if (currentConversationId === current.id) setConversation(detail);
      setConversations(items);
      setLastLatency(Math.round(performance.now() - startedAt));
      if (terminal.type === "cancelled") toastApi.info("已停止生成");
    } catch (error) {
      const failure = buildRunFailureCopy({
        status: "failed",
        statusCode: error.status,
        error: error.message,
        publicError: error.payload,
        model: payload.model,
      });
      void refreshGatewayStatus();
      let persistedFailure = false;
      try {
        const detail = await runtimeAdapter.getConversation(current.id);
        persistedFailure = detail.latestRun?.status === "failed" && detail.latestRun?.requestId === payload.requestId;
        if (currentConversationId === current.id) setConversation(detail);
      } catch {
        // 原始流错误已经足够诊断，恢复读取失败不覆盖它。
      }
      setRunError(persistedFailure ? "" : `${failure.title}：${error.payload?.detail || failure.detail}`);
    } finally {
      cancelRequestedRef.current = false;
      setActiveRunFact(null);
    }
  }

  /** 提交当前 Sender 输入；编辑恢复态会携带来源，但仍创建全新幂等 Run。 */
  function handleSubmit(value) {
    const payload = buildRunPayload(
      value,
      attachmentFactsRef.current,
      referenceFactsRef.current,
      selectedModelRef.current,
      pendingRecovery || undefined,
    );
    void executeRun(payload);
  }

  /** 清除当前非持久化错误提示。 */
  function clearRunError() {
    setRunError("");
  }

  /** 打开移动端会话 Drawer。 */
  function openConversationDrawer() {
    setConversationDrawerOpen(true);
  }

  /** 关闭移动端会话 Drawer。 */
  function closeConversationDrawer() {
    setConversationDrawerOpen(false);
  }

  /** 打开移动端上下文 Drawer。 */
  function openContextDrawer() {
    setContextDrawerOpen(true);
  }

  /** 关闭移动端上下文 Drawer。 */
  function closeContextDrawer() {
    setContextDrawerOpen(false);
  }

  /** 在桌面端展开或收起运行上下文 Inspector。 */
  function toggleContextInspector() {
    setContextExpanded(!contextExpanded);
  }

  /** 从失败提示打开运行上下文；窄屏使用 Drawer，桌面使用 Inspector。 */
  function openRunContext() {
    if (globalThis.matchMedia?.("(max-width: 900px)").matches) {
      setContextDrawerOpen(true);
      return;
    }
    setContextExpanded(true);
  }

  /** 通过 Bubble.List 公开接口回到视觉底部，并恢复后续内容跟随。 */
  function scrollMessageListToLatest(behavior = "smooth") {
    scrollReadyMessageListToLatest(messageListRef.current, behavior);
  }

  /** 响应用户的“回到最新”命令。 */
  function handleReturnToLatest() {
    scrollMessageListToLatest();
  }

  /** 根据反向滚动列表的位置切换跟随状态，用户向上浏览时保留当前视窗。 */
  function handleMessageListScroll(event) {
    const followingLatest = isMessageListAtLatest(event.currentTarget.scrollTop);
    setIsFollowingLatest(followingLatest);
    if (followingLatest) setUnseenMessageCount(0);
  }

  /** 按稳定 messageId 定位并短暂高亮当前会话中的来源消息。 */
  function handleNavigateToMessage(messageId) {
    const element = document.getElementById(messageElementId(messageId));
    if (!element) {
      const existsOutsideWindow = visibleMessages.some(
        // 当前完整详情中存在时先扩展窗口，再等待 React 提交 DOM。
        (message) => message.id === messageId,
      );
      if (existsOutsideWindow) {
        setMessageLimit(Math.max(MESSAGE_PAGE_SIZE, visibleMessages.length));
        requestAnimationFrame(
          /** 下一帧等待消息窗口扩展完成后再次定位。 */
          function retryMessageNavigation() {
            requestAnimationFrame(
              /** 第二帧使用已经提交的消息 DOM 完成定位。 */
              function navigateExpandedMessage() {
                focusMessageTarget(messageId);
              },
            );
          },
        );
        return;
      }
      toastApi.warning("当前消息暂时不可定位");
      return;
    }
    focusMessageTarget(messageId);
  }

  /** 高亮并聚焦已经进入 DOM 的消息目标。 */
  function focusMessageTarget(messageId) {
    const element = document.getElementById(messageElementId(messageId));
    if (!element) return;
    element.classList.remove("is-reference-target");
    void element.offsetWidth;
    element.classList.add("is-reference-target");
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus({ preventScroll: true });
    /** 动画完成后移除状态，允许再次点击同一引用时重新播放。 */
    function clearReferenceHighlight() {
      element.classList.remove("is-reference-target");
    }
    element.addEventListener("animationend", clearReferenceHighlight, { once: true });
  }

  /** 复制消息正文并提供移动端可见反馈。 */
  async function handleCopyMessage(message) {
    try {
      await navigator.clipboard.writeText(message.displayContent || "");
      toastApi.success("已复制消息");
    } catch {
      toastApi.error("复制失败，请手动选择消息内容");
    }
  }

  /** 复制回答中的代码块，并复用统一的可见反馈。 */
  async function handleCopyCode(value) {
    try {
      await navigator.clipboard.writeText(String(value || ""));
      toastApi.success("已复制代码");
    } catch {
      toastApi.error("复制失败，请手动选择代码");
    }
  }

  /** 将助手原始 Markdown 下载为本地文件，不改写服务端消息正文。 */
  function handleDownloadMessage(message) {
    const blob = new Blob([String(message.displayContent || "")], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ai-answer-${String(message.id || "message").replace(/[^a-zA-Z0-9_-]/g, "-")}.md`;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(
      /** 让浏览器先接管 Blob 下载，再释放页面局部 URL。 */
      function releaseDownloadUrl() {
        URL.revokeObjectURL(url);
      },
      0,
    );
  }

  /** 定位长回答中的 Markdown 标题并把焦点交给目标标题。 */
  function handleNavigateToHeading(headingId) {
    const element = document.getElementById(headingId);
    if (!element) return;
    element.scrollIntoView({ behavior: "smooth", block: "start" });
    element.focus({ preventScroll: true });
  }

  /** 加载下一批更早消息，保持最近消息仍在当前窗口中。 */
  function handleLoadEarlierMessages() {
    setMessageLimit(messageLimit + MESSAGE_PAGE_SIZE);
  }

  const visibleMessages = useMemo(
    // 服务端消息是基线，活动 Run 只追加当前渠道的乐观用户与助手消息。
    () => buildVisibleMessages(conversation, activeRun, currentConversationId),
    [conversation, activeRun, currentConversationId],
  );
  const messageWindow = useMemo(
    // 消息渐进窗口只影响浏览器渲染，SQLite 详情仍是完整事实。
    () => buildMessageWindow(visibleMessages, messageLimit),
    [visibleMessages, messageLimit],
  );
  const conversationWorkspace = useMemo(
    // 会话检索、归档筛选和时间分组均为渠道派生状态。
    () => buildConversationWorkspace(conversations, {
      query: conversationQuery,
      filter: conversationFilter,
      limit: conversationLimit,
    }),
    [conversations, conversationQuery, conversationFilter, conversationLimit],
  );

  // 用户主动发送新消息时回到底部；后续向上浏览仍由 onScroll 关闭跟随。
  useEffect(() => {
    if (!activeRun?.requestId) return;
    scrollMessageListToLatest("smooth");
  }, [activeRun?.requestId]);

  // 按会话统计离开底部后新增的消息条数，流式文本增长不会重复计数。
  useEffect(() => {
    const previous = visibleMessageCountRef.current;
    const nextCount = visibleMessages.length;
    if (previous.conversationId !== currentConversationId) {
      visibleMessageCountRef.current = { conversationId: currentConversationId, count: nextCount };
      setUnseenMessageCount(0);
      return;
    }
    const addedCount = Math.max(0, nextCount - previous.count);
    visibleMessageCountRef.current = { conversationId: currentConversationId, count: nextCount };
    if (isFollowingLatest) {
      setUnseenMessageCount(0);
      return;
    }
    if (addedCount > 0) {
      /** 合并同一次事实刷新中新增的消息，避免覆盖尚未查看的数量。 */
      function addUnseenMessages(currentCount) {
        return currentCount + addedCount;
      }
      setUnseenMessageCount(addUnseenMessages);
    }
  }, [currentConversationId, visibleMessages.length, isFollowingLatest]);

  const bubbleItems = useMemo(
    // Bubble 项只承载展示状态，messageId 和正文事实仍来自服务端消息。
    () => buildBubbleItems(messageWindow.messages, {
      busy: Boolean(activeRun),
      onQuote: handleQuoteMessage,
      onCopy: handleCopyMessage,
      onCopyCode: handleCopyCode,
      onDownload: handleDownloadMessage,
      onNavigateReference: handleNavigateToMessage,
      onNavigateHeading: handleNavigateToHeading,
      onEditRecoveryInput: handleEditRecoveryInput,
      onRetryRun: handleRetryRun,
      onRegenerateRun: handleRegenerateRun,
      onContinueRun: handleContinueRun,
      onOpenContext: openRunContext,
    }),
    [messageWindow.messages],
  );
  const canSubmit = canSubmitRun({
    conversationStatus: conversation?.status,
    gatewayOk: gateway?.ok,
    activeRun,
    hasInput: composerValue.trim() || attachments.length > 0 || references.length > 0,
  });
  const modelOptions = readGatewayModels(gateway).map(
    // Ant Design Select 只需要稳定别名，不暴露真实上游模型配置。
    (model) => ({ value: model, label: model }),
  );

  /** 将附件、模型和发送动作收口到 Sender 底部工具栏，正文输入独占上层。 */
  function renderSenderFooter(originalNode, { components }) {
    return (
      <div className="sender-footer">
        <Dropdown
          menu={attachmentMenu}
          trigger={["click"]}
          disabled={Boolean(activeRun) || !conversation || conversation.status !== "active"}
        >
          <Tooltip title="添加附件">
            <Button
              className="sender-tool-button"
              type="text"
              shape="circle"
              icon={<Plus size={20} />}
              aria-label="添加附件"
            />
          </Tooltip>
        </Dropdown>
        <div className="sender-footer-actions">
          <div className="sender-model-select">
            <Select
              variant="borderless"
              value={selectedModel || undefined}
              options={modelOptions}
              disabled={Boolean(activeRun) || gateway?.ok !== true || modelOptions.length === 0}
              placeholder="无可用模型"
              aria-label="选择模型"
              popupMatchSelectWidth={false}
              onChange={handleModelChange}
            />
          </div>
          <div className="sender-submit-action">
            {activeRun ? originalNode : <components.SendButton disabled={!canSubmit} aria-label="发送消息" />}
          </div>
        </div>
      </div>
    );
  }

  const attachmentMenu = {
    items: [
      { key: "upload-image", label: "上传图片", icon: <FileImage size={16} /> },
      { key: "image-url", label: "图片链接", icon: <Link2 size={16} /> },
      { key: "document-url", label: "文档链接", icon: <FileText size={16} /> },
    ],
    onClick: handleAttachmentMenuClick,
  };
  const senderHeaderOpen = attachments.length > 0 || references.length > 0;
  const senderHeaderTitle = buildSenderHeaderTitle(references.length, attachments.length);
  const currentManifest = conversation?.latestRun?.contextManifest || conversation?.lastRun?.contextManifest || null;

  return (
    <div className={`app-shell${contextExpanded ? "" : " context-collapsed"}`}>
      {toastContext}
      <aside className="conversation-sidebar desktop-only">
        <ConversationPanel
          workspace={conversationWorkspace}
          currentId={currentConversationId}
          activeRun={activeRun}
          gateway={gateway}
          gatewayChecking={gatewayChecking}
          query={conversationQuery}
          filter={conversationFilter}
          onChange={handleConversationChange}
          onCreate={handleCreateConversation}
          onQueryChange={handleConversationQueryChange}
          onFilterChange={handleConversationFilterChange}
          onLoadMore={handleLoadMoreConversations}
          onRename={handleOpenConversationRename}
          onArchive={handleConversationArchive}
          onRefreshGateway={handleRefreshGateway}
        />
      </aside>

      <main className="chat-workspace">
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {buildLiveStatus(activeRun, runError, unseenMessageCount)}
        </div>
        <header className="chat-header">
          <Tooltip title="会话">
            <Button
              className="mobile-only"
              type="text"
              icon={<Menu size={19} />}
              aria-label="打开会话列表"
              onClick={openConversationDrawer}
            />
          </Tooltip>
          <div className="chat-heading">
            <Title level={4}>{conversation?.title || "AI 应用基础平台"}</Title>
            <div className="chat-subheading">
              <Tag color={conversation?.status === "closed" ? "default" : "green"}>
                {conversationStatusLabel(conversation?.status)}
              </Tag>
              {activeRun ? <Tag color="processing">{activeRun.status === "stopping" ? "正在停止" : "生成中"}</Tag> : null}
              {lastLatency != null ? <Text type="secondary">{lastLatency} ms</Text> : null}
            </div>
          </div>
          <div className="chat-header-actions">
            <Tooltip title="结束会话">
              <Button
                type="text"
                icon={<Archive size={18} />}
                aria-label="结束当前会话"
                disabled={!conversation || conversation.status !== "active" || Boolean(activeRun)}
                onClick={handleCloseConversation}
              />
            </Tooltip>
            <Tooltip title={contextExpanded ? "收起运行上下文" : "展开运行上下文"}>
              <Button
                className={`desktop-only context-toggle${conversation?.latestRun?.status === "failed" ? " has-error" : ""}`}
                type="text"
                icon={<PanelRight size={19} />}
                aria-label={contextExpanded ? "收起运行上下文" : "展开运行上下文"}
                aria-pressed={contextExpanded}
                onClick={toggleContextInspector}
              />
            </Tooltip>
            <Tooltip title="运行上下文">
              <Button
                className="mobile-only"
                type="text"
                icon={<PanelRight size={19} />}
                aria-label="打开运行上下文"
                onClick={openContextDrawer}
              />
            </Tooltip>
          </div>
        </header>

        <section className="message-stage" aria-label="会话消息">
          {initializing || (!conversation && !runError) ? (
            <div className="center-state"><Bot className="loading-bot" size={28} /></div>
          ) : visibleMessages.length === 0 ? (
            <EmptyConversation onPromptClick={handlePromptClick} />
          ) : (
            <>
              {messageWindow.hasMore ? (
                <Button className="load-earlier-messages" size="small" onClick={handleLoadEarlierMessages}>
                  加载更早消息 · {messageWindow.hiddenCount}
                </Button>
              ) : null}
              <Bubble.List
                ref={messageListRef}
                className="message-list"
                items={bubbleItems}
                autoScroll
                onScroll={handleMessageListScroll}
              />
            </>
          )}
          <ConversationAnchorRail
            messages={messageWindow.messages}
            onNavigate={handleNavigateToMessage}
          />
          {!isFollowingLatest && visibleMessages.length > 0 ? (
            <Button
              className="return-to-latest"
              size="small"
              icon={<ArrowDown size={14} />}
              aria-label={unseenMessageCount > 0 ? `回到最新，${unseenMessageCount} 条新消息` : "回到最新"}
              onClick={handleReturnToLatest}
            >
              {unseenMessageCount > 0 ? `回到最新 · ${unseenMessageCount}` : "回到最新"}
            </Button>
          ) : null}
        </section>

        <section className="composer-dock" aria-label="消息输入">
          {gateway?.ok === false ? (
            <Alert
              className="gateway-alert"
              type="warning"
              showIcon
              message="模型网关不可达，当前输入会保留但无法发送"
              action={(
                <Button size="small" loading={gatewayChecking} onClick={handleRefreshGateway}>
                  重新检测
                </Button>
              )}
            />
          ) : null}
          {runError ? <Alert type="error" showIcon closable message={runError} onClose={clearRunError} /> : null}
          {pendingRecovery ? (
            <div className="pending-recovery" role="status">
              <RotateCcw size={14} />
              <span>{recoveryModeLabel(pendingRecovery.recoveryMode)}</span>
              <Tooltip title="取消恢复关系">
                <Button type="text" size="small" icon={<X size={14} />} aria-label="取消恢复关系" onClick={clearPendingRecovery} />
              </Tooltip>
            </div>
          ) : null}
          <Sender
            value={composerValue}
            loading={Boolean(activeRun)}
            disabled={!conversation || conversation.status !== "active"}
            placeholder={conversation?.status === "closed" ? "当前会话已结束" : "输入消息"}
            autoSize={{ minRows: 1, maxRows: 6 }}
            onChange={handleComposerChange}
            onSubmit={handleSubmit}
            onCancel={handleCancelGeneration}
            onPasteFile={handlePasteFiles}
            prefix={false}
            suffix={false}
            footer={renderSenderFooter}
            header={
              <Sender.Header forceRender open={senderHeaderOpen} title={senderHeaderTitle} closable={false}>
                <ReferenceQueue references={references} onRemove={handleRemoveReference} />
                <Attachments
                  ref={attachmentComponentRef}
                  className={attachments.length === 0 ? "attachment-uploader-empty" : undefined}
                  items={attachments}
                  accept="image/*"
                  multiple
                  maxCount={MAX_ATTACHMENTS}
                  beforeUpload={handleBeforeUpload}
                  onRemove={handleRemoveAttachment}
                  overflow="scrollX"
                />
              </Sender.Header>
            }
          />
        </section>
      </main>

      <aside className="context-sidebar desktop-only" hidden={!contextExpanded}>
        <ContextPanel conversation={conversation} manifest={currentManifest} activeRun={activeRun} />
      </aside>

      <Drawer
        className="mobile-drawer"
        title="会话"
        placement="left"
        width="min(88vw, 320px)"
        open={conversationDrawerOpen}
        onClose={closeConversationDrawer}
      >
        <ConversationPanel
          workspace={conversationWorkspace}
          currentId={currentConversationId}
          activeRun={activeRun}
          gateway={gateway}
          gatewayChecking={gatewayChecking}
          query={conversationQuery}
          filter={conversationFilter}
          onChange={handleConversationChange}
          onCreate={handleCreateConversation}
          onQueryChange={handleConversationQueryChange}
          onFilterChange={handleConversationFilterChange}
          onLoadMore={handleLoadMoreConversations}
          onRename={handleOpenConversationRename}
          onArchive={handleConversationArchive}
          onRefreshGateway={handleRefreshGateway}
        />
      </Drawer>
      <Drawer
        className="mobile-drawer"
        title="运行上下文"
        placement="right"
        width="min(92vw, 360px)"
        open={contextDrawerOpen}
        onClose={closeContextDrawer}
      >
        <ContextPanel conversation={conversation} manifest={currentManifest} activeRun={activeRun} />
      </Drawer>

      <Modal
        title="重命名会话"
        open={renameDraft.open}
        okText="保存"
        cancelText="取消"
        onOk={confirmConversationRename}
        onCancel={closeConversationRename}
      >
        <Input
          autoFocus
          maxLength={80}
          value={renameDraft.value}
          status={renameDraft.error ? "error" : undefined}
          aria-label="会话标题"
          onChange={handleConversationRenameChange}
          onPressEnter={confirmConversationRename}
        />
        {renameDraft.error ? <Text className="field-error" type="danger">{renameDraft.error}</Text> : null}
      </Modal>

      <Modal
        title={linkDraft.type === "image" ? "添加图片链接" : "添加文档链接"}
        open={linkDraft.open}
        okText="添加"
        cancelText="取消"
        onOk={confirmLinkDraft}
        onCancel={closeLinkDraft}
      >
        <Input
          autoFocus
          value={linkDraft.value}
          status={linkDraft.error ? "error" : undefined}
          placeholder="https://"
          prefix={linkDraft.type === "image" ? <FileImage size={16} /> : <FileText size={16} />}
          onChange={handleLinkDraftChange}
          onPressEnter={confirmLinkDraft}
        />
        {linkDraft.error ? <Text className="field-error" type="danger">{linkDraft.error}</Text> : null}
      </Modal>
    </div>
  );
}

/** 渲染品牌、网关状态和受控会话列表。 */
function ConversationPanel({
  workspace,
  currentId,
  activeRun,
  gateway,
  gatewayChecking,
  query,
  filter,
  onChange,
  onCreate,
  onQueryChange,
  onFilterChange,
  onLoadMore,
  onRename,
  onArchive,
  onRefreshGateway,
}) {
  const gatewayCopy = buildGatewayReachabilityCopy(gateway);
  const items = [];
  for (const item of workspace.conversations) {
    items.push({
      key: item.id,
      conversation: item,
      group: item.timeGroup,
      disabled: Boolean(activeRun && item.id !== currentId),
      label: (
        <div className="conversation-label">
          <span className="conversation-name">{item.title}</span>
          <span className="conversation-meta">
            {conversationStatusLabel(item.status)} · {item.messageCount} 条
          </span>
        </div>
      ),
    });
  }

  /** 为每条会话建立重命名与独立归档菜单。 */
  function buildConversationMenu(item) {
    const conversation = item.conversation;
    return {
      items: [
        { key: "rename", label: "重命名", icon: <Pencil size={15} />, disabled: Boolean(activeRun) },
        {
          key: "archive",
          label: conversation.archivedAt ? "取消归档" : "归档",
          icon: conversation.archivedAt ? <ArchiveRestore size={15} /> : <Archive size={15} />,
          disabled: Boolean(activeRun),
        },
      ],
      /** 将菜单命令映射到顶层事实操作，并阻止触发会话切换。 */
      onClick({ key, domEvent }) {
        domEvent?.stopPropagation();
        if (key === "rename") onRename(conversation);
        if (key === "archive") void onArchive(conversation);
      },
    };
  }
  return (
    <div className="conversation-panel">
      <div className="brand-lockup">
        <span className="brand-mark"><Bot size={21} /></span>
        <div>
          <strong>AI 应用基础平台</strong>
          <span>C1 对话</span>
        </div>
      </div>
      <div className="gateway-line">
        <span className={`gateway-dot is-${gatewayCopy.state}`} />
        <Tooltip title={gatewayCopy.detail}>
          <Text ellipsis>{gatewayCopy.label}</Text>
        </Tooltip>
        <Tooltip title="重新检测模型网关">
          <Button
            className="gateway-refresh"
            type="text"
            size="small"
            loading={gatewayChecking}
            icon={<RefreshCw size={14} />}
            aria-label="重新检测模型网关"
            onClick={onRefreshGateway}
          />
        </Tooltip>
      </div>
      <div className="conversation-tools">
        <Input
          allowClear
          size="small"
          value={query}
          prefix={<Search size={14} />}
          placeholder="搜索会话"
          aria-label="搜索会话"
          data-conversation-search
          onChange={onQueryChange}
        />
        <Segmented
          block
          size="small"
          value={filter}
          aria-label="会话归档筛选"
          options={[
            { label: "当前", value: "active" },
            { label: "归档", value: "archived" },
            { label: "全部", value: "all" },
          ]}
          onChange={onFilterChange}
        />
      </div>
      <Conversations
        className="conversation-list"
        items={items}
        activeKey={currentId || undefined}
        menu={buildConversationMenu}
        groupable={{
          collapsible: true,
          defaultExpandedKeys: ["今天", "昨天", "最近 7 天", "更早"],
        }}
        onActiveChange={onChange}
        creation={{
          label: "新建会话",
          icon: <Plus size={17} />,
          disabled: Boolean(activeRun),
          onClick: onCreate,
        }}
      />
      {workspace.hasMore ? (
        <Button className="load-more-conversations" type="text" size="small" onClick={onLoadMore}>
          加载更多
        </Button>
      ) : null}
      <div className="sidebar-footer">{workspace.total} 个会话</div>
    </div>
  );
}

/** 渲染空会话的克制入口和可直接填入的建议。 */
function EmptyConversation({ onPromptClick }) {
  const promptItems = [
    { key: "summary", label: "总结这段会话的关键决策" },
    { key: "boundary", label: "检查当前方案的边界与风险" },
    { key: "next", label: "基于已有上下文给出下一步" },
  ];
  return (
    <div className="empty-conversation">
      <Welcome icon={<Bot size={28} />} title="开始新的对话" variant="borderless" />
      <Prompts items={promptItems} wrap onItemClick={onPromptClick} />
    </div>
  );
}

/** 渲染待发送引用，并以 messageId 为删除边界。 */
function ReferenceQueue({ references, onRemove }) {
  if (references.length === 0) return null;
  const nodes = [];
  for (const reference of references) {
    /** 从当前闭包引用稳定 ID，移除时不依赖列表索引。 */
    function removeCurrentReference() {
      onRemove(reference.messageId);
    }
    nodes.push(
      <div className="reference-chip" key={reference.messageId}>
        <MessageSquareQuote size={15} />
        <span><strong>{reference.role === "assistant" ? "助手" : "用户"}</strong>{reference.preview}</span>
        <Tooltip title="移除引用">
          <Button type="text" size="small" icon={<X size={14} />} aria-label="移除引用" onClick={removeCurrentReference} />
        </Tooltip>
      </div>,
    );
  }
  return <div className="reference-queue">{nodes}</div>;
}

/** 渲染消息正文、可定位引用预览、长回答导航和图片事实。 */
function MessageBody({
  message,
  streaming = false,
  referenceMessages = [],
  onNavigateReference,
  onNavigateHeading,
  onCopyCode,
}) {
  const imageUrls = getMessageImageUrls(message);
  const hasDisplayContent = Boolean(String(message.displayContent || "").trim());
  const headings = message.role === "assistant"
    ? extractMarkdownHeadings(message.displayContent, message.id)
    : [];
  const markdownComponents = buildMarkdownComponents(headings, onCopyCode);
  const referenceNodes = [];
  for (const referenceMessage of referenceMessages) {
    referenceNodes.push(
      <ReferencedMessage
        key={referenceMessage.id}
        message={referenceMessage}
        onNavigate={onNavigateReference}
      />,
    );
  }
  const headingNodes = [];
  for (const heading of headings) {
    /** 定位当前回答中的稳定标题锚点。 */
    function navigateCurrentHeading() {
      onNavigateHeading(heading.id);
    }
    headingNodes.push(
      <button
        key={heading.id}
        className={`answer-heading-link level-${heading.level}`}
        type="button"
        onClick={navigateCurrentHeading}
      >
        {heading.title}
      </button>,
    );
  }
  return (
    <div
      id={messageElementId(message.id)}
      className="message-body-content"
      data-message-id={message.id}
      tabIndex={-1}
    >
      {referenceMessages.length > 0 ? (
        <div className="message-references">{referenceNodes}</div>
      ) : null}
      {imageUrls.length > 0 ? (
        <div className="message-images">
          {imageUrls.map(renderMessageImage)}
        </div>
      ) : null}
      {streaming ? (
        <div className="message-generation-status" role="status" aria-live="polite">
          <LoaderCircle className="message-generation-spinner" size={14} />
          <span>{activeRunStageLabel(message.runStatus, hasDisplayContent, message.toolTitle)}</span>
        </div>
      ) : null}
      {!streaming && headingNodes.length > 1 ? (
        <nav className="answer-heading-nav" aria-label="回答目录">
          <span>本回答</span>
          <div>{headingNodes}</div>
        </nav>
      ) : null}
      {hasDisplayContent || !streaming ? (
        <XMarkdown
          content={message.displayContent || "(空消息)"}
          components={markdownComponents}
          streaming={streaming ? { hasNextChunk: true, enableAnimation: true, tail: true } : undefined}
          escapeRawHtml
          openLinksInNewTab
        />
      ) : null}
      {message.status === "interrupted" ? <Tag className="message-status-tag">已停止</Tag> : null}
    </div>
  );
}

/** 建立 X Markdown 标签映射，保持原始正文不变并增强结果消费。 */
function buildMarkdownComponents(headings, onCopyCode) {
  const occurrences = new Map();
  const components = {
    a: SafeMarkdownLink,
    /** 给块级代码增加显式复制操作，行内代码仍使用默认组件。 */
    pre(props) {
      const { children, domNode, streamStatus, ...elementProps } = props;
      const code = readReactText(children).replace(/\n$/, "");
      /** 复制当前代码块的纯文本。 */
      function copyCurrentCode() {
        void onCopyCode(code);
      }
      return (
        <div className="markdown-code-block">
          <Tooltip title="复制代码">
            <Button
              className="markdown-code-copy"
              type="text"
              size="small"
              icon={<Copy size={14} />}
              aria-label="复制代码"
              onClick={copyCurrentCode}
            />
          </Tooltip>
          <pre {...elementProps}>{children}</pre>
        </div>
      );
    },
  };
  for (let level = 1; level <= 6; level += 1) {
    const tagName = `h${level}`;
    /** 为一个 Markdown 标题级别创建带稳定 id 的语义标题组件。 */
    function createHeading() {
      /** 渲染标题并按相同标题出现顺序匹配导航锚点。 */
      function MarkdownHeading(props) {
        const { children, domNode, streamStatus, ...elementProps } = props;
        const title = readReactText(children).trim();
        const key = `${level}:${title}`;
        const occurrence = (occurrences.get(key) || 0) + 1;
        occurrences.set(key, occurrence);
        const matches = headings.filter(
          // 标题导航只匹配同层级和同文本的已提取 ATX 标题。
          (heading) => heading.level === level && heading.title === title,
        );
        const heading = matches[occurrence - 1];
        return React.createElement(tagName, {
          ...elementProps,
          id: heading?.id,
          tabIndex: heading ? -1 : undefined,
        }, children);
      }
      return MarkdownHeading;
    }
    components[tagName] = createHeading();
  }
  return components;
}

/** 渲染协议受限的 Markdown 链接，外链强制隔离 opener。 */
function SafeMarkdownLink(props) {
  const { children, domNode, streamStatus, href, ...elementProps } = props;
  if (!isSafeMarkdownHref(href)) return <span>{children}</span>;
  const isExternal = /^https?:/i.test(String(href));
  return (
    <a
      {...elementProps}
      href={href}
      target={isExternal ? "_blank" : undefined}
      rel={isExternal ? "noopener noreferrer" : undefined}
    >
      {children}
    </a>
  );
}

/** 从 React 子节点递归读取纯文本，供代码复制和标题匹配使用。 */
function readReactText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(readReactText).join("");
  if (React.isValidElement(node)) return readReactText(node.props.children);
  return "";
}

/** 将一条被引用消息渲染为可定位到来源的只读证据预览。 */
function ReferencedMessage({ message, onNavigate }) {
  /** 使用稳定 messageId 请求页面定位来源消息。 */
  function navigateToSource() {
    onNavigate(message.id);
  }
  return (
    <button className="message-reference" type="button" onClick={navigateToSource}>
      <Quote size={14} />
      <span>{buildMessagePreview(message.displayContent)}</span>
    </button>
  );
}

/** 将消息中的图片 URL 渲染为受约束缩略图。 */
function renderMessageImage(url) {
  return <Image key={url.slice(0, 96)} src={url} alt="消息图片" width={112} height={84} />;
}

/** 渲染桌面快捷操作和移动端菜单；历史事实只允许派生新 Run，不提供删除或原位编辑。 */
function MessageActions({
  message,
  canRegenerate,
  canContinue,
  disabled,
  onQuote,
  onCopy,
  onDownload,
  onRegenerate,
  onContinue,
}) {
  /** 把当前稳定消息交给页面引用队列。 */
  function quoteCurrentMessage() {
    onQuote(message);
  }
  /** 把当前消息正文交给页面统一复制反馈。 */
  function copyCurrentMessage() {
    void onCopy(message);
  }
  /** 下载当前助手回答的原始 Markdown。 */
  function downloadCurrentMessage() {
    onDownload(message);
  }
  /** 从当前 completed Run 创建新的重新生成 Run。 */
  function regenerateCurrentMessage() {
    onRegenerate(message.runId);
  }
  /** 从当前 cancelled Run 创建新的继续生成 Run。 */
  function continueCurrentMessage() {
    onContinue(message.runId);
  }
  /** 将移动端菜单命令映射到同一复制和引用动作。 */
  function handleMobileMessageAction({ key }) {
    if (key === "copy") copyCurrentMessage();
    if (key === "quote") quoteCurrentMessage();
    if (key === "download") downloadCurrentMessage();
    if (key === "regenerate") regenerateCurrentMessage();
    if (key === "continue") continueCurrentMessage();
  }
  const desktopActions = [
    {
      key: "quote",
      label: "引用",
      actionRender: (
        <Tooltip title="引用">
          <Button
            type="text"
            size="small"
            icon={<Quote size={15} />}
            aria-label="引用消息"
            onClick={quoteCurrentMessage}
          />
        </Tooltip>
      ),
    },
  ];
  if (message.role === "assistant") {
    desktopActions.push({
      key: "download",
      label: "下载 Markdown",
      actionRender: (
        <Tooltip title="下载 Markdown">
          <Button
            type="text"
            size="small"
            icon={<Download size={15} />}
            aria-label="下载 Markdown"
            onClick={downloadCurrentMessage}
          />
        </Tooltip>
      ),
    });
  }
  if (canRegenerate) {
    desktopActions.push({
      key: "regenerate",
      label: "重新生成",
      actionRender: (
        <Tooltip title="重新生成">
          <Button
            type="text"
            size="small"
            disabled={disabled}
            icon={<RefreshCw size={15} />}
            aria-label="重新生成回答"
            onClick={regenerateCurrentMessage}
          />
        </Tooltip>
      ),
    });
  }
  if (canContinue) {
    desktopActions.push({
      key: "continue",
      label: "继续生成",
      actionRender: (
        <Tooltip title="继续生成">
          <Button
            type="text"
            size="small"
            disabled={disabled}
            icon={<RotateCcw size={15} />}
            aria-label="继续生成回答"
            onClick={continueCurrentMessage}
          />
        </Tooltip>
      ),
    });
  }
  const mobileItems = [
    { key: "copy", label: "复制", icon: <Copy size={15} /> },
    { key: "quote", label: "引用", icon: <Quote size={15} /> },
  ];
  if (message.role === "assistant") mobileItems.push({ key: "download", label: "下载 Markdown", icon: <Download size={15} /> });
  if (canRegenerate) mobileItems.push({ key: "regenerate", label: "重新生成", icon: <RefreshCw size={15} />, disabled });
  if (canContinue) mobileItems.push({ key: "continue", label: "继续生成", icon: <RotateCcw size={15} />, disabled });
  const mobileMenu = {
    items: mobileItems,
    onClick: handleMobileMessageAction,
  };
  return (
    <div className="message-actions">
      <div className="desktop-message-actions">
        <Tooltip title="复制">
          <Actions.Copy text={message.displayContent || ""} aria-label="复制消息" />
        </Tooltip>
        <Actions items={desktopActions} />
      </div>
      <Dropdown menu={mobileMenu} trigger={["click"]}>
        <Button
          className="mobile-message-actions"
          type="text"
          size="small"
          icon={<Ellipsis size={17} />}
          aria-label="消息操作"
        />
      </Dropdown>
    </div>
  );
}

/** 渲染持久失败状态和创建新 Run 的恢复入口。 */
function RunFailureNotice({ message, disabled, onRetry, onEdit, onOpenContext }) {
  const failure = message.failure || buildRunFailureCopy(message);
  /** 直接用失败 Run 的稳定输入创建新 retry Run。 */
  function retrySourceRun() {
    onRetry(message.runId);
  }
  /** 恢复失败输入到 Sender，并把下一次提交标记为 retry。 */
  function editSourceInput() {
    onEdit(message.sourceMessageId, message.runId, "retry");
  }
  return (
    <div id={messageElementId(message.id)} className="run-failure-notice" role="status" tabIndex={-1}>
      <CircleAlert size={18} />
      <div className="run-failure-copy">
        <strong>{failure.title}</strong>
        <span>{failure.detail}</span>
        <span className="run-failure-recovery">{failure.action} 输入已保存。</span>
      </div>
      <div className="run-failure-actions">
        <Button size="small" disabled={disabled} icon={<RotateCcw size={14} />} onClick={retrySourceRun}>重试</Button>
        <Button size="small" disabled={disabled} onClick={editSourceInput}>编辑后发送</Button>
        <Button size="small" type="text" onClick={onOpenContext}>运行信息</Button>
      </div>
    </div>
  );
}

/** 把会话消息和活动 Run 转换为 Ant Design X Bubble 数据。 */
function buildBubbleItems(messages, handlers) {
  const persistedMessages = [];
  for (const message of messages) {
    if (!message.streaming) persistedMessages.push(message);
  }
  let lastRegeneratableMessageId = null;
  for (const message of persistedMessages) {
    if (message.role === "assistant" && message.status !== "interrupted" && message.runId) {
      lastRegeneratableMessageId = message.id;
    }
  }
  const items = [];
  for (const message of messages) {
    if (message.kind === "run-failure") {
      items.push({
        key: message.id,
        role: "ai",
        placement: "start",
        variant: "borderless",
        content: (
          <RunFailureNotice
            message={message}
            disabled={handlers.busy}
            onRetry={handlers.onRetryRun}
            onEdit={handlers.onEditRecoveryInput}
            onOpenContext={handlers.onOpenContext}
          />
        ),
      });
      continue;
    }
    const isAssistant = message.role === "assistant";
    const referenceMessages = resolveReferenceMessages(message.references, persistedMessages);
    items.push({
      key: message.id,
      role: isAssistant ? "ai" : "user",
      placement: isAssistant ? "start" : "end",
      variant: isAssistant ? "borderless" : "filled",
      status: message.status === "interrupted" ? "abort" : message.streaming ? "updating" : "success",
      streaming: Boolean(message.streaming),
      loading: false,
      content: (
        <MessageBody
          message={message}
          streaming={message.streaming}
          referenceMessages={referenceMessages}
          onNavigateReference={handlers.onNavigateReference}
          onNavigateHeading={handlers.onNavigateHeading}
          onCopyCode={handlers.onCopyCode}
        />
      ),
      footer:
        message.streaming ||
        String(message.id).startsWith("optimistic:") ||
        String(message.id).startsWith("streaming:") ? null : (
          <MessageActions
            message={message}
            canRegenerate={message.id === lastRegeneratableMessageId}
            canContinue={message.role === "assistant" && message.status === "interrupted" && Boolean(message.runId)}
            disabled={handlers.busy}
            onQuote={handlers.onQuote}
            onCopy={handlers.onCopy}
            onDownload={handlers.onDownload}
            onRegenerate={handlers.onRegenerateRun}
            onContinue={handlers.onContinueRun}
          />
        ),
    });
  }
  return items;
}

/** 在服务端消息基线上追加当前渠道尚未收口的乐观消息。 */
function buildVisibleMessages(conversation, activeRun, currentConversationId) {
  const messages = conversation?.messages ? [...conversation.messages] : [];
  if (!activeRun || activeRun.conversationId !== currentConversationId) {
    return insertLatestRunFailure(messages, conversation?.latestRun);
  }
  messages.push(activeRun.optimisticUser);
  if (activeRun.status === "cancelled" && !activeRun.partialText) return messages;
  messages.push({
    id: `streaming:${activeRun.requestId}`,
    conversationId: activeRun.conversationId,
    role: "assistant",
    displayContent: activeRun.partialText,
    status: activeRun.status === "cancelled" ? "interrupted" : "committed",
    references: [],
    streaming: activeRun.status !== "cancelled",
    runStatus: activeRun.status,
    toolTitle: activeRun.toolTitle || "",
  });
  return messages;
}

/** 使用服务端已返回的当前会话消息解析引用预览。 */
function resolveReferenceMessages(references, messages) {
  const resolved = [];
  if (!Array.isArray(references)) return resolved;
  for (const reference of references) {
    if (reference.type !== "conversation_message") continue;
    for (const message of messages) {
      if (message.id === reference.messageId) {
        resolved.push(message);
        break;
      }
    }
  }
  return resolved;
}

/** 生成包含当前输入、稳定引用、恢复来源和全新幂等标识的 Run 载荷。 */
function buildRunPayload(value, attachments, references, model, recovery = {}) {
  const imageUrls = [];
  const documentUrls = [];
  for (const attachment of attachments) {
    if (attachment.kind === "image") imageUrls.push(attachment.url);
    else documentUrls.push(attachment.url);
  }
  const stableReferences = [];
  for (const reference of references) {
    stableReferences.push({ type: "conversation_message", messageId: reference.messageId });
  }
  return {
    requestId: crypto.randomUUID(),
    clientMessageId: crypto.randomUUID(),
    model: String(model || "").trim(),
    message: String(value || "").trim(),
    imageUrls,
    documentUrls,
    references: stableReferences,
    ...(recovery.sourceRunId ? { sourceRunId: recovery.sourceRunId } : {}),
    ...(recovery.recoveryMode ? { recoveryMode: recovery.recoveryMode } : {}),
  };
}

/** 判断 Run 是否至少包含正文、附件或稳定消息引用。 */
function hasRunInput(payload) {
  return Boolean(
    payload.message || payload.imageUrls.length || payload.documentUrls.length || payload.references.length,
  );
}

/** 为活动 Run 构造不进入事实源的乐观用户消息。 */
function buildOptimisticUserMessage(conversationId, payload) {
  return {
    id: `optimistic:${payload.clientMessageId}`,
    conversationId,
    clientMessageId: payload.clientMessageId,
    role: "user",
    displayContent: formatDisplayInput(payload),
    status: "local",
    references: payload.references,
    imageUrls: payload.imageUrls,
  };
}

/** 将 Run 输入转换为与服务端 displayContent 一致的乐观文本。 */
function formatDisplayInput(payload) {
  const sections = [];
  if (payload.message) sections.push(payload.message);
  if (payload.imageUrls.length > 0) sections.push(`图片：${payload.imageUrls.length} 个`);
  if (payload.documentUrls.length > 0) {
    const links = [];
    for (const url of payload.documentUrls) links.push(`- ${url}`);
    sections.push(`参考文档链接：\n${links.join("\n")}`);
  }
  if (sections.length === 0 && payload.references.length > 0) sections.push(`引用了 ${payload.references.length} 条消息`);
  return sections.join("\n\n");
}

/** 从持久化多模态 content 或乐观快照提取图片地址。 */
function getMessageImageUrls(message) {
  if (Array.isArray(message.imageUrls)) return message.imageUrls;
  const urls = [];
  if (!Array.isArray(message.content)) return urls;
  for (const part of message.content) {
    if (part?.type === "image_url" && part.image_url?.url) urls.push(part.image_url.url);
  }
  return urls;
}

/** 把恢复出的图片和文档地址转换为受控 Attachments 项，并继续执行渠道数量上限。 */
function buildRecoveredAttachments(imageUrls, documentUrls) {
  const items = [];
  for (const url of imageUrls.slice(0, MAX_IMAGES)) {
    if (items.length >= MAX_ATTACHMENTS) break;
    items.push(createRecoveredAttachment(url, "image", items.length));
  }
  for (const url of documentUrls) {
    if (items.length >= MAX_ATTACHMENTS) break;
    items.push(createRecoveredAttachment(url, "document", items.length));
  }
  return items;
}

/** 为一条持久化附件地址创建新的渠道局部身份，不复用旧上传组件状态。 */
function createRecoveredAttachment(url, kind, index) {
  const isImage = kind === "image";
  return {
    uid: crypto.randomUUID(),
    name: isImage && String(url).startsWith("data:") ? `恢复图片-${index + 1}` : readableUrlName(url),
    status: "done",
    url,
    thumbUrl: isImage ? url : undefined,
    cardType: isImage ? "image" : "file",
    kind,
    description: isImage ? "图片" : "文档链接",
  };
}

/** 按当前会话消息补齐恢复引用的角色和预览，缺失来源不会进入草稿。 */
function buildRecoveredReferences(references, messages) {
  const facts = [];
  for (const reference of references) {
    if (facts.length >= MAX_REFERENCES) break;
    const source = messages.find(
      // 恢复引用只匹配当前会话内同 ID 的服务端消息。
      (message) => message.id === reference.messageId,
    );
    if (!source) continue;
    facts.push({
      type: "conversation_message",
      messageId: source.id,
      role: source.role,
      preview: buildMessagePreview(source.displayContent),
    });
  }
  return facts;
}

/** 生成无需 CSS 转义即可由 DOM API 精确查找的消息锚点。 */
function messageElementId(messageId) {
  return `conversation-message-${String(messageId)}`;
}

/** 将浏览器 File 对象异步读取为 data URL。 */
function readFileAsDataUrl(file) {
  return new Promise(
    // Promise executor 只桥接 FileReader 事件，不改变文件内容或持久化附件。
    (resolve, reject) => {
      const reader = new FileReader();
      /** 返回 FileReader 已完成的 data URL。 */
      function handleLoad() {
        resolve(String(reader.result));
      }
      reader.addEventListener("load", handleLoad);
      reader.addEventListener("error", reject);
      reader.readAsDataURL(file);
    },
  );
}

/** 统计当前受控附件中的图片数量。 */
function countImageAttachments(items) {
  let count = 0;
  for (const item of items) if (item.kind === "image") count += 1;
  return count;
}

/** 只接受 Runtime 当前已开放的 http(s) 链接协议。 */
function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 从 URL 生成适合附件列表扫描的短名称。 */
function readableUrlName(value) {
  try {
    const url = new URL(value);
    const tail = url.pathname.split("/").filter(Boolean).at(-1);
    return tail || url.hostname;
  } catch {
    return value;
  }
}

/** 组合 Sender Header 中的引用与附件计数。 */
function buildSenderHeaderTitle(referenceCount, attachmentCount) {
  const parts = [];
  if (referenceCount) parts.push(`${referenceCount} 条引用`);
  if (attachmentCount) parts.push(`${attachmentCount} 个附件`);
  return parts.join(" · ");
}

/** 渲染最新 Run Context Manifest 与 active 结构化记忆。 */
function ContextPanel({ conversation, manifest, activeRun }) {
  if (!conversation) return <div className="context-panel"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /></div>;
  const memoryItems = [];
  for (const item of conversation.memory?.items || []) {
    if (item.status === "active") memoryItems.push(item);
  }
  const selected = manifest?.selected || {};
  const tokenPercent = manifest?.budget ? Math.min(100, Math.round((manifest.countedTokens / manifest.budget) * 100)) : 0;
  const latestStatus = activeRun ? activeRun.status : conversation.latestRun?.status || "idle";
  return (
    <div className="context-panel">
      <div className="context-heading">
        <div>
          <Text type="secondary">运行上下文</Text>
          <Title level={5}>Context Manifest</Title>
        </div>
        <Tag color={runStatusColor(latestStatus)}>{runStatusLabel(latestStatus)}</Tag>
      </div>

      <section className="context-section">
        <div className="section-title"><Gauge size={16} /><span>Token</span></div>
        <div className="token-line">
          <strong>{manifest ? `${manifest.countedTokens} / ${manifest.budget}` : "-"}</strong>
          <span>{manifest?.tokenCounter || "等待 Run"}</span>
        </div>
        <Progress percent={tokenPercent} showInfo={false} strokeColor="#1677ff" trailColor="#e8eaed" />
        <div className="watermark-row">
          <Tag color={manifest?.highWatermarkReached ? "orange" : "default"}>高水位</Tag>
          <Tag color={manifest?.hardLimitReached ? "red" : "default"}>硬水位</Tag>
        </div>
      </section>

      <section className="context-section">
        <div className="section-title"><Database size={16} /><span>装箱结果</span></div>
        <div className="metric-grid">
          <Metric label="直接引用" value={countItems(selected.referenceMessageIds)} />
          <Metric label="结构记忆" value={countItems(selected.memoryItemIds)} />
          <Metric label="Episode" value={countItems(selected.episodeIds)} />
          <Metric label="历史消息" value={countItems(selected.historyMessageIds)} />
        </div>
        <Text className="context-version" type="secondary">
          会话 v{conversation.version} · 记忆 v{conversation.memory?.version ?? 0} · seq {conversation.lastSeq}
        </Text>
      </section>

      <section className="context-section memory-section">
        <div className="section-title"><Brain size={16} /><span>结构化记忆</span><Tag>{memoryItems.length}</Tag></div>
        {memoryItems.length === 0 ? (
          <Text type="secondary">暂无 active 记忆</Text>
        ) : (
          <div className="memory-list">{memoryItems.slice(0, 12).map(renderMemoryItem)}</div>
        )}
      </section>
    </div>
  );
}

/** 渲染单个 Context 指标。 */
function Metric({ label, value }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

/** 渲染一条 active 结构化记忆。 */
function renderMemoryItem(item) {
  return (
    <div className="memory-item" key={item.id}>
      <span>{item.type} · {item.entity}.{item.key}</span>
      <strong>{formatMemoryValue(item.value)}</strong>
    </div>
  );
}

/** 将结构化记忆值转换为可扫描文本。 */
function formatMemoryValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** 安全读取可选 ID 数组长度。 */
function countItems(value) {
  return Array.isArray(value) ? value.length : 0;
}

/** 把编辑恢复模式映射为 Sender 上方的简短状态。 */
function recoveryModeLabel(mode) {
  const labels = {
    retry: "正在编辑失败输入，发送后将创建新重试 Run",
    regenerate: "正在编辑历史输入，发送后将创建新重新生成 Run",
    continue: "正在编辑继续输入，发送后将创建新继续 Run",
  };
  return labels[mode] || "下一次发送将创建关联恢复 Run";
}

/** 汇总不会抢占焦点的渠道状态，供屏幕阅读器礼貌播报。 */
function buildLiveStatus(activeRun, runError, unseenMessageCount) {
  if (runError) return runError;
  if (activeRun) return activeRunStageLabel(activeRun.status, Boolean(activeRun.partialText), activeRun.toolTitle);
  if (unseenMessageCount > 0) return `${unseenMessageCount} 条新消息`;
  return "";
}

/** 把 Runtime 状态映射为中文渠道标签。 */
function runStatusLabel(status) {
  const labels = {
    idle: "等待运行",
    starting: "正在创建",
    running: "生成中",
    "tool-running": "查询工具中",
    stopping: "正在停止",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
  };
  return labels[status] || status;
}

/** 把 Runtime 状态映射为 Ant Design Tag 色彩。 */
function runStatusColor(status) {
  if (["running", "tool-running", "starting", "stopping"].includes(status)) return "processing";
  if (status === "completed") return "green";
  if (status === "cancelled") return "orange";
  if (status === "failed") return "red";
  return "default";
}

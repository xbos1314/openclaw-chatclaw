// ============ APP → Plugin ============

// 发送文字
export interface SendTextMessage {
  type: "send_text";
  agent_id: string;
  text: string;
  request_id?: string;
}

// 发送图片
export interface SendImageMessage {
  type: "send_image";
  agent_id: string;
  file_url: string;
  file_name?: string;
  file_size?: number;
  duration?: number;
  request_id?: string;
}

// 发送语音
export interface SendVoiceMessage {
  type: "send_voice";
  agent_id: string;
  file_url: string;
  file_name?: string;
  file_size?: number;
  duration?: number;
  request_id?: string;
}

// 发送音频
export interface SendAudioMessage {
  type: "send_audio";
  agent_id: string;
  file_url: string;
  file_name?: string;
  file_size?: number;
  duration?: number;
  request_id?: string;
}

// 发送视频
export interface SendVideoMessage {
  type: "send_video";
  agent_id: string;
  file_url: string;
  cover_url?: string;
  file_name?: string;
  file_size?: number;
  duration?: number;
  request_id?: string;
}

// 发送文件
export interface SendFileMessage {
  type: "send_file";
  agent_id: string;
  file_url: string;
  file_name?: string;
  file_size?: number;
  request_id?: string;
}

// 拉取消息（分页）
export interface PullMessagesMessage {
  type: "pull_messages";
  agent_id: string;
  page?: number;
  page_size?: number;
}

// 同步消息（增量）
export interface SyncMessagesMessage {
  type: "sync_messages";
  agent_id: string;
  since?: number;
}

// 获取智能体列表
export interface GetAgentsMessage {
  type: "get_agents";
}

// 心跳
export interface PingMessage {
  type: "ping";
}

// 清空消息
export interface ClearMessagesMessage {
  type: "clear_messages";
  agent_id: string;
}

// 删除单条消息
export interface DeleteMessageMessage {
  type: "delete_message";
  message_id: string;
}

// 更新消息（如更新时长）
export interface UpdateMessageMessage {
  type: "update_message";
  message_id: string;
  duration?: number;
}

// ============ Plugin → APP ============

// 智能体列表
export interface AgentsListMessage {
  type: "agents_list";
  agents: Array<{
    id: string;
    name: string;
    description?: string;
    avatar?: string;  // 头像 URL
  }>;
}

// 消息（通用）
export interface MessageContent {
  type: "text" | "image" | "file" | "voice" | "audio" | "video";
  text?: string;
  file_url?: string;
  cover_url?: string;
  file_name?: string;
}

export interface OutboundMessage {
  type: "message";
  id: string;
  agent_id: string;
  content: MessageContent;
  timestamp: number;
}

// 消息发送确认
export interface MessageSentMessage {
  type: "message_sent";
  request_id: string;
  message_id: string;
}

// 消息列表（分页响应）
export interface MessagesListMessage {
  type: "messages_list";
  data: Message[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

// 消息同步响应
export interface MessagesSyncMessage {
  type: "messages_sync";
  data: Message[];
}

// 心跳响应
export interface PongMessage {
  type: "pong";
}

// 消息已清空响应
export interface MessagesClearedMessage {
  type: "messages_cleared";
  agent_id: string;
}

// 消息已删除响应
export interface MessageDeletedMessage {
  type: "message_deleted";
  message_id: string;
}

// 错误
export interface ErrorMessage {
  type: "error";
  error: string;
  request_id?: string;
}

// ============ Message 类型（数据库模型） ============

export interface Message {
  id: string;
  accountId: string;
  agentId: string;
  direction: "inbound" | "outbound";
  contentType: string;
  content: string;
  fileUrl?: string;
  coverUrl?: string;
  fileName?: string;
  fileSize?: number;
  duration?: number;
  requestId?: string;
  status: string;
  read: number;
  createdAt: number;
  updatedAt: number;
}

#!/usr/bin/env node
import {
  createAccount,
  listIndexedChatClawAccountIds,
  loadChatClawAccount,
  clearChatClawAccount,
  unregisterChatClawAccountId,
  resetAccountPassword,
  findAccountByUsername,
  listAllowedAgentIds,
  setAllowedAgentIds,
  clearAllowedAgentIds,
} from "../dist/auth/accounts.js";

async function main() {
  const command = process.argv[2];
  const username = process.argv[3];
  const password = process.argv[4];

  switch (command) {
    case "create":
      if (!username || !password) {
        console.error("用法: chatclaw-account create <用户名> <密码>");
        process.exit(1);
      }
      try {
        const account = await createAccount(username, password);
        console.log(`✓ 账号创建成功`);
        console.log(`  用户名: ${account.username}`);
        console.log(`  账号ID: ${account.accountId}`);
      } catch (err) {
        console.error(`✗ 创建失败: ${err}`);
        process.exit(1);
      }
      break;

    case "list":
      const accountIds = await listIndexedChatClawAccountIds();
      if (accountIds.length === 0) {
        console.log("没有账号");
      } else {
        console.log(`共 ${accountIds.length} 个账号:\n`);
        for (const id of accountIds) {
          const account = await loadChatClawAccount(id);
          if (account) {
            console.log(`  用户名: ${account.username}`);
            console.log(`  账号ID: ${account.accountId}`);
            console.log(`  创建时间: ${account.createdAt}`);
            console.log(`  最后登录: ${account.lastConnected || "从未登录"}`);
            console.log();
          }
        }
      }
      break;

    case "list-agent-limits": {
      if (!username) {
        console.error("用法: chatclaw-account list-agent-limits <用户名>");
        process.exit(1);
      }
      const account = await findAccountByUsername(username);
      if (!account) {
        console.error(`✗ 账号不存在: ${username}`);
        process.exit(1);
      }

      const agentIds = await listAllowedAgentIds(account.accountId);
      console.log(`账号: ${account.username}`);
      console.log(`账号ID: ${account.accountId}`);
      if (agentIds.length === 0) {
        console.log("智能体限制: 未配置（默认可访问全部智能体）");
      } else {
        console.log(`智能体限制: ${agentIds.join(", ")}`);
      }
      break;
    }

    case "set-agent-limits": {
      if (!username) {
        console.error("用法: chatclaw-account set-agent-limits <用户名> <agentId1,agentId2,...>");
        process.exit(1);
      }
      const agentIdsArg = process.argv[4];
      if (!agentIdsArg) {
        console.error("用法: chatclaw-account set-agent-limits <用户名> <agentId1,agentId2,...>");
        process.exit(1);
      }

      const account = await findAccountByUsername(username);
      if (!account) {
        console.error(`✗ 账号不存在: ${username}`);
        process.exit(1);
      }

      const agentIds = agentIdsArg.split(",").map((id) => id.trim()).filter(Boolean);
      if (agentIds.length === 0) {
        console.error("✗ 至少需要一个有效的 agentId");
        process.exit(1);
      }

      const updatedAccount = await setAllowedAgentIds(account.accountId, agentIds);
      const savedAgentIds = updatedAccount?.agentIds || [];
      console.log("✓ 智能体限制已更新");
      console.log(`  用户名: ${account.username}`);
      console.log(`  账号ID: ${account.accountId}`);
      console.log(`  允许智能体: ${savedAgentIds.join(", ")}`);
      break;
    }

    case "clear-agent-limits": {
      if (!username) {
        console.error("用法: chatclaw-account clear-agent-limits <用户名>");
        process.exit(1);
      }

      const account = await findAccountByUsername(username);
      if (!account) {
        console.error(`✗ 账号不存在: ${username}`);
        process.exit(1);
      }

      await clearAllowedAgentIds(account.accountId);
      console.log("✓ 智能体限制已清空");
      console.log(`  用户名: ${account.username}`);
      console.log(`  账号ID: ${account.accountId}`);
      console.log("  当前状态: 可访问全部智能体");
      break;
    }

    case "delete":
      if (!username) {
        console.error("用法: chatclaw-account delete <用户名>");
        process.exit(1);
      }
      const allIds = await listIndexedChatClawAccountIds();
      let accountToDelete = null;
      for (const id of allIds) {
        const account = await loadChatClawAccount(id);
        if (account?.username === username) {
          accountToDelete = account;
          break;
        }
      }

      if (!accountToDelete) {
        console.error(`✗ 账号不存在: ${username}`);
        process.exit(1);
      }
      await clearChatClawAccount(accountToDelete.accountId);
      await unregisterChatClawAccountId(accountToDelete.accountId);
      console.log(`✓ 账号已删除: ${username}`);
      break;

    case "reset-password":
      if (!username || !password) {
        console.error("用法: chatclaw-account reset-password <用户名> <新密码>");
        process.exit(1);
      }
      const account = await resetAccountPassword(username, password);
      if (!account) {
        console.error(`✗ 账号不存在: ${username}`);
        process.exit(1);
      }
      console.log(`✓ 密码已重置`);
      console.log(`  用户名: ${account.username}`);
      console.log(`  账号ID: ${account.accountId}`);
      break;

    default:
      console.log("ChatClaw 账号管理工具\n");
      console.log("用法:");
      console.log("  chatclaw-account create <用户名> <密码>  - 创建新账号");
      console.log("  chatclaw-account list                   - 列出所有账号");
      console.log("  chatclaw-account list-agent-limits <用户名> - 查看账号智能体限制");
      console.log("  chatclaw-account set-agent-limits <用户名> <智能体ID列表> - 设置账号可访问智能体");
      console.log("  chatclaw-account clear-agent-limits <用户名> - 清空账号智能体限制");
      console.log("  chatclaw-account delete <用户名>        - 删除账号");
      console.log("  chatclaw-account reset-password <用户名> <密码> - 重置账号密码");
      process.exit(1);
  }
}

main();

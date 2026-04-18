#!/bin/bash
# Stop hook: 检测是否有未提交的变更，如果有则注入提示让 AI 执行提交决策
# 通过 stdout 输出 JSON message 注入到对话上下文

cd "$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# 检查是否有变更（staged + unstaged + untracked）
changes=$(git status --porcelain 2>/dev/null)

if [ -z "$changes" ]; then
  # 无变更，不注入任何提示
  exit 0
fi

# 获取上一次提交信息，供 AI 判断是否 amend
last_commit_msg=$(git log -1 --pretty=format:"%s" 2>/dev/null | sed 's/\\/\\\\/g; s/"/\\"/g')
current_branch=$(git branch --show-current 2>/dev/null)
last_commit_pushed=$(git log --oneline "origin/${current_branch}..HEAD" 2>/dev/null | wc -l | tr -d ' ')

push_status="已推送到远端"
if [ "$last_commit_pushed" -gt 0 ] 2>/dev/null; then
  push_status="未推送(本地)"
fi

# 将 git status 输出转为 JSON 安全字符串（转义换行、引号、反斜杠）
changes_escaped=$(echo "$changes" | head -20 | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')

# 构造注入消息 — 使用 printf 避免 heredoc 中的换行问题
printf '{"message":"<auto-commit-check>\\n检测到未提交的文件变更，请执行提交决策流程：\\n1. 判断是否需要提交（是否有实质性代码变更）\\n2. 如需提交，判断 amend 还是新提交（参考 CLAUDE.md 中的提交决策规则）\\n3. 执行提交\\n\\n当前 git status:\\n%s\\n\\n上一次提交: %s\\n上一次提交是否已推送: %s\\n</auto-commit-check>"}\n' \
  "$changes_escaped" \
  "$last_commit_msg" \
  "$push_status"

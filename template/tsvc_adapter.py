"""
TSVC Adapter — Framework-Specific Implementation

Implement these functions for your agent framework.
The core TSVC logic calls these — you provide the glue.
"""

import os
import json
from typing import Optional


# ============================================================
# IMPLEMENT: Session Management
# ============================================================

def trigger_session_reset():
    """
    Reset the agent's session to get a clean context window.
    
    This is the most framework-specific function. Examples:
    - OpenClaw: send /reset via openclaw message send
    - LangChain: create new ConversationBufferMemory
    - Bare API: clear message history array, re-inject system prompt
    - Letta: create new agent state with fresh core memory
    
    This function should NOT block — the reset happens after the
    current turn completes.
    """
    # IMPLEMENT: Your framework's session reset mechanism
    raise NotImplementedError("Implement trigger_session_reset() for your framework")


def inject_context(context: str):
    """
    Add the topic's context into the agent's current context window.
    
    Examples:
    - Prepend to system prompt
    - Add as a system message
    - Load into core memory (Letta)
    - Set as conversation context variable
    
    Args:
        context: The content of the topic's context file (markdown string)
    """
    # IMPLEMENT: Inject context into your agent's prompt/memory
    raise NotImplementedError("Implement inject_context() for your framework")


def send_message(text: str):
    """
    Send a message to the user.
    
    Used after topic switches to respond immediately.
    
    Args:
        text: The message to send
    """
    # IMPLEMENT: Send message through your framework's output channel
    raise NotImplementedError("Implement send_message() for your framework")


# ============================================================
# IMPLEMENT: Message Classification
# ============================================================

def classify_message(message: str, current_topic: dict, all_topics: list) -> Optional[str]:
    """
    Determine which topic a message belongs to.
    
    Return the topic_id if a switch is needed, or None to stay on current topic.
    
    Strategies (pick one or combine):
    1. Keyword matching against topic titles and descriptions
    2. LLM classification: "Given these topics, which does this message belong to?"
    3. Regex patterns for explicit switches ("switch to X", "let's talk about Y")
    
    Args:
        message: The user's message
        current_topic: Dict with id, title, description of current topic
        all_topics: List of all topic dicts
    
    Returns:
        topic_id to switch to, or None to stay on current topic
    """
    # IMPLEMENT: Your topic detection logic
    
    # Example: simple explicit detection
    message_lower = message.lower()
    if message_lower.startswith("switch to "):
        target = message_lower.replace("switch to ", "").strip()
        for topic in all_topics:
            if target in topic.get("title", "").lower():
                return topic["id"]
    
    return None  # Stay on current topic


# ============================================================
# IMPLEMENT: Boot Hook
# ============================================================

def on_agent_boot():
    """
    Called when your agent starts a new session.
    
    Wire this into your framework's startup sequence.
    Must be called BEFORE processing any user messages.
    
    This function is already implemented — it calls the core
    TSVC boot logic. Just make sure it gets called.
    """
    from tsvc_core import handle_boot
    handle_boot()


# ============================================================
# Configuration
# ============================================================

# Path to your TSVC directory (relative to agent workspace)
TSVC_DIR = os.environ.get("TSVC_DIR", os.path.join(os.getcwd(), "tsvc"))

# Maximum tokens for a context file before pruning
MAX_CONTEXT_TOKENS = int(os.environ.get("TSVC_MAX_CONTEXT_TOKENS", "3000"))

# Number of recent exchanges to keep in context file
RECENT_EXCHANGES_COUNT = int(os.environ.get("TSVC_RECENT_EXCHANGES", "5"))

# Number of recent decisions to keep in context file  
RECENT_DECISIONS_COUNT = int(os.environ.get("TSVC_RECENT_DECISIONS", "10"))

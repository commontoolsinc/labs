import { getLogger, log, setLogLevel } from "./logger.ts";

// Basic logging
log("Hello from basic logger");

// Module-tagged logging - auto-detects caller
const logger = getLogger();
logger.info("should see [1/3]: Processing user data");
logger.debug(
  "dont see: This debug message won't show (filtered) because default is info",
);

// Create a disabled logger for verbose debugging
const debugLogger = getLogger({ enabled: false });
debugLogger.info("dont see: logger is disabled");

// Create a logger with its own log level
const verboseDebugLogger = getLogger({ enabled: true, level: "debug" });
verboseDebugLogger.debug(() => ["should see [2/3]: my favourite number:", 42]);

// Change severity to warn - only warnings and errors will show
setLogLevel("warn");
logger.info("dont see: This info message won't show anymore");
logger.warn(() => `should see [3/3]: random number: ${Math.random() * 100}`);

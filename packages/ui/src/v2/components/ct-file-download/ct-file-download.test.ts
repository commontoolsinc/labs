/**
 * Tests for CTFileDownload component
 */
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CTFileDownload } from "./ct-file-download.ts";

describe("CTFileDownload", () => {
  describe("component definition", () => {
    it("should be defined", () => {
      expect(CTFileDownload).toBeDefined();
    });

    it("should have customElement definition", () => {
      expect(customElements.get("ct-file-download")).toBe(CTFileDownload);
    });

    it("should create element instance", () => {
      const element = new CTFileDownload();
      expect(element).toBeInstanceOf(CTFileDownload);
    });
  });

  describe("default properties", () => {
    it("should have correct default values", () => {
      const element = new CTFileDownload();
      expect(element.data).toBe("");
      expect(element.filename).toBe("");
      expect(element.mimeType).toBe("application/octet-stream");
      expect(element.base64).toBe(false);
      expect(element.variant).toBe("secondary");
      expect(element.size).toBe("default");
      expect(element.disabled).toBe(false);
      expect(element.feedbackDuration).toBe(2000);
      expect(element.iconOnly).toBe(false);
      expect(element.allowAutosave).toBe(false);
    });
  });

  describe("filename sanitization", () => {
    it("should remove path traversal attempts", () => {
      const element = new CTFileDownload();
      element.filename = "../../../etc/passwd";
      // Access private method via type assertion for testing
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename("../../../etc/passwd");
      expect(sanitized).not.toContain("..");
      expect(sanitized).toBe("______etc_passwd");
    });

    it("should remove special characters", () => {
      const element = new CTFileDownload();
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename('file<>:"/\\|?*name.txt');
      expect(sanitized).not.toMatch(/[<>:"\/\\|?*]/);
      expect(sanitized).toBe("file_________name.txt");
    });

    it("should truncate long filenames to 255 characters", () => {
      const element = new CTFileDownload();
      const longName = "a".repeat(300);
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename(longName);
      expect(sanitized.length).toBe(255);
    });

    it("should handle normal filenames unchanged", () => {
      const element = new CTFileDownload();
      const sanitized = (element as unknown as {
        _sanitizeFilename: (f: string) => string;
      })._sanitizeFilename("my-file_2024.json");
      expect(sanitized).toBe("my-file_2024.json");
    });
  });

  describe("blob creation", () => {
    it("should create text blob for plain data", () => {
      const element = new CTFileDownload();
      element.mimeType = "text/plain";
      const blob = (element as unknown as {
        _createBlob: (d: string) => Blob;
      })._createBlob("Hello, World!");
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe("text/plain");
      expect(blob.size).toBe(13);
    });

    it("should decode base64 data when base64 flag is set", () => {
      const element = new CTFileDownload();
      element.base64 = true;
      element.mimeType = "text/plain";
      // "Hello" in base64 is "SGVsbG8="
      const blob = (element as unknown as {
        _createBlob: (d: string) => Blob;
      })._createBlob("SGVsbG8=");
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(5); // "Hello" is 5 bytes
    });

    it("should trim whitespace from base64 data", () => {
      const element = new CTFileDownload();
      element.base64 = true;
      element.mimeType = "text/plain";
      // Base64 with surrounding whitespace
      const blob = (element as unknown as {
        _createBlob: (d: string) => Blob;
      })._createBlob("  SGVsbG8=  \n");
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBe(5);
    });

    it("should throw on invalid base64 data", () => {
      const element = new CTFileDownload();
      element.base64 = true;
      expect(() => {
        (element as unknown as {
          _createBlob: (d: string) => Blob;
        })._createBlob("not-valid-base64!!!");
      }).toThrow(/Invalid base64 data/);
    });
  });

  describe("auto-generated filename", () => {
    it("should generate filename with correct extension for JSON", () => {
      const element = new CTFileDownload();
      element.mimeType = "application/json";
      const filename = (element as unknown as {
        _getFilename: () => string;
      })._getFilename();
      expect(filename).toMatch(
        /^download-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.json$/,
      );
    });

    it("should generate filename with correct extension for CSV", () => {
      const element = new CTFileDownload();
      element.mimeType = "text/csv";
      const filename = (element as unknown as {
        _getFilename: () => string;
      })._getFilename();
      expect(filename).toMatch(/\.csv$/);
    });

    it("should use bin extension for unknown MIME types", () => {
      const element = new CTFileDownload();
      element.mimeType = "application/x-unknown";
      const filename = (element as unknown as {
        _getFilename: () => string;
      })._getFilename();
      expect(filename).toMatch(/\.bin$/);
    });
  });

  describe("size limits", () => {
    it("should have MAX_FILE_SIZE of 100MB", () => {
      // Access static property
      const maxSize = (CTFileDownload as unknown as {
        MAX_FILE_SIZE: number;
      }).MAX_FILE_SIZE;
      expect(maxSize).toBe(100 * 1024 * 1024);
    });
  });

  describe("autosave configuration", () => {
    it("should have AUTOSAVE_INTERVAL of 60 seconds", () => {
      const interval = (CTFileDownload as unknown as {
        AUTOSAVE_INTERVAL: number;
      }).AUTOSAVE_INTERVAL;
      expect(interval).toBe(60_000);
    });

    it("should set allowAutosave via property", () => {
      const element = new CTFileDownload();
      element.allowAutosave = true;
      expect(element.allowAutosave).toBe(true);
    });

    it("should have autosave indicator methods", () => {
      const element = new CTFileDownload();
      // Access private methods for testing
      const getIndicatorClass = (element as unknown as {
        _getAutosaveIndicatorClass: () => string;
      })._getAutosaveIndicatorClass;
      const getTooltip = (element as unknown as {
        _getAutosaveTooltip: () => string;
      })._getAutosaveTooltip;

      expect(typeof getIndicatorClass).toBe("function");
      expect(typeof getTooltip).toBe("function");
    });

    it("should return empty indicator class when autosave disabled", () => {
      const element = new CTFileDownload();
      const indicatorClass = (element as unknown as {
        _getAutosaveIndicatorClass: () => string;
      })._getAutosaveIndicatorClass();
      expect(indicatorClass).toBe("");
    });

    it("should return empty tooltip when autosave disabled", () => {
      const element = new CTFileDownload();
      const tooltip = (element as unknown as {
        _getAutosaveTooltip: () => string;
      })._getAutosaveTooltip();
      expect(tooltip).toBe("");
    });
  });
});

import { describe, it, expect } from 'vitest';
import { _parsePublicUrl } from '../../src/config/brands';

describe('Brand URL Configuration', () => {
  it('should parse a valid HTTPS URL', () => {
    const result = _parsePublicUrl('https://github.com/yosuke1024/Judgie-AI', 'https://fallback.example.invalid');
    expect(result).toBe('https://github.com/yosuke1024/Judgie-AI');
  });

  it('should use fallback when value is undefined', () => {
    const result = _parsePublicUrl(undefined, 'https://github.com/yosuke1024/Judgie-AI');
    expect(result).toBe('https://github.com/yosuke1024/Judgie-AI');
  });

  it('should use fallback when value is empty string', () => {
    const result = _parsePublicUrl('  ', 'https://pixapps.ai/');
    expect(result).toBe('https://pixapps.ai/');
  });

  it('should reject http: URLs', () => {
    expect(() => _parsePublicUrl('http://insecure.com', 'https://fallback.com')).toThrow(
      'Public brand URL must use HTTPS'
    );
  });

  it('should reject javascript: URLs', () => {
    expect(() => _parsePublicUrl('javascript:alert(1)', 'https://fallback.com')).toThrow();
  });

  it('should reject example.com URLs', () => {
    expect(() => _parsePublicUrl('https://judgie.example.com', 'https://fallback.com')).toThrow(
      'Public brand URL must not use example.com'
    );
  });

  it('should reject "undefined" string value', () => {
    expect(() => _parsePublicUrl('undefined', 'https://fallback.com')).toThrow(
      'Public brand URL must not be "undefined"'
    );
  });

  it('should reject "null" string value', () => {
    expect(() => _parsePublicUrl('null', 'https://fallback.com')).toThrow(
      'Public brand URL must not be "null"'
    );
  });

  it('should reject URLs without protocol (e.g. example.com)', () => {
    expect(() => _parsePublicUrl('example.com', 'https://fallback.com')).toThrow();
  });

  it('should preserve existing query parameters in the URL', () => {
    const result = _parsePublicUrl('https://pixapps.ai/?ref=test', 'https://fallback.com');
    const url = new URL(result);
    expect(url.searchParams.get('ref')).toBe('test');
  });
});

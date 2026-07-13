export class TimezoneUtil {
  static getJSTDate(dateInput?: string | Date): Date {
    return dateInput ? new Date(dateInput) : new Date();
  }

  static getJSTString(dateInput?: string | Date): string {
    const d = this.getJSTDate(dateInput);
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).formatToParts(d);
    
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+09:00`;
  }

  static getJSTDateKey(dateInput?: string | Date): string {
    const d = this.getJSTDate(dateInput);
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(d);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }

  static getRunKey(season: number, dateInput?: string | Date): string {
    return `season-${season}-${this.getJSTDateKey(dateInput)}-daily`;
  }

  static getJSTYearMonth(dateInput?: string | Date): { year: string, month: string } {
    const d = this.getJSTDate(dateInput);
    const parts = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit'
    }).formatToParts(d);
    const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
    return { year: p.year, month: p.month };
  }

  static getDayOfWeek(dateInput?: string | Date): string {
    const d = this.getJSTDate(dateInput);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tokyo', weekday: 'long'
    }).formatToParts(d);
    return parts.find(p => p.type === 'weekday')?.value.toLowerCase() || 'sunday';
  }
}

declare module 'lunar-javascript' {
  export class EightChar {
    setSect(sect: number): void;
    getYear(): string;
    getYearGan(): string;
    getYearZhi(): string;
    getYearWuXing(): string;
    getYearShiShenGan(): string;
    getYearShiShenZhi(): string[];
    getYearHideGan(): string[];
    getMonth(): string;
    getMonthGan(): string;
    getMonthZhi(): string;
    getMonthWuXing(): string;
    getMonthShiShenGan(): string;
    getMonthShiShenZhi(): string[];
    getMonthHideGan(): string[];
    getDay(): string;
    getDayGan(): string;
    getDayZhi(): string;
    getDayWuXing(): string;
    getDayShiShenZhi(): string[];
    getDayHideGan(): string[];
    getTime(): string;
    getTimeGan(): string;
    getTimeZhi(): string;
    getTimeWuXing(): string;
    getTimeShiShenGan(): string;
    getTimeShiShenZhi(): string[];
    getTimeHideGan(): string[];
    getYun(gender: number): {
      getDaYun(count?: number): Array<{
        getGanZhi(): string;
        getStartAge(): number;
        getStartYear(): number;
        getEndYear(): number;
        getLiuNian(count?: number): Array<{
          getYear(): number;
          getGanZhi(): string;
          getAge(): number;
        }>;
      }>;
    };
  }

  export class Lunar {
    getEightChar(): EightChar;
    getYearInGanZhi(): string;
    getYearInGanZhiByLiChun(): string;
    getMonthInGanZhi(): string;
    getMonthInGanZhiExact(): string;
  }

  export class Solar {
    static fromYmdHms(
      year: number,
      month: number,
      day: number,
      hour: number,
      minute: number,
      second: number,
    ): Solar;
    getLunar(): Lunar;
  }
}

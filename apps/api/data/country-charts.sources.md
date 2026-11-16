# 国家事件盘数据来源

版本 `2026-11-16-1`，2026-11-16 复核。首版仅发布中国一条事件记录。

- 事件、日期、当地时刻及地点：[中华人民共和国外交部，Color Footage of the Founding Ceremony of the People's Republic of China](https://www.fmprc.gov.cn/eng./zy/jj/zggcddwjw100ggs/jszgddzg/202406/t20240606_11377939.html)，页面标注 2022-08-29。文章明确记载 1949-10-01 下午三点在天安门城楼宣告中央人民政府成立。
- 坐标：继承旧 Vela `vela-agent/backend/alembic/versions/v1a26_country_chart_versions.py` 的天安门城楼近似位置 (39.9087, 116.3975)，作为产品事件地点，不宣称测绘精度。时区使用 IANA `Asia/Shanghai`，运行时解析历史偏移。
- 只提取公开事件事实，中文说明自行撰写，未复制文章正文、图片或视频；原文版权属于原网站。
- 这是产品采用的事件盘口径，不断言存在唯一国家出生时间。`verified` 表示来源明确给出该事件时刻，不代表政治或占星解释确定。
- 未核实其他国家的事件时刻，因此不发布假定午夜/中午的记录。国家/地区映射首版仅显式包含 CN → CN；其他地理代码不猜测映射。
- 已发布 ID/版本不可修改；改动事件或来源说明须追加新版本并调整 catalogVersion。测试核对固定内容哈希，后续新增版本必须保留历史记录。

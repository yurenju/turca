# Turca

多台裝置各自演奏一首曲子的一部分，同步播放；指揮站在攝影機前用手勢控制速度與各聲部的大小聲。

## Language

### 房間與裝置

**房間 (Room)**：
一次演奏的集合點，指揮端開房、其他裝置掃碼加入。
_Avoid_: session、lobby

**指揮端 (Conductor Device)**：
開房並讀取指揮手勢的那台裝置（通常是有鏡頭的筆電）。
_Avoid_: host、主控、conductor

**座位 (Seat)**：
房間裡負責演奏的一台裝置（手機或電腦）所佔的位置，一台裝置就是一個座位。一個座位負責一個或多個聲部。
_Avoid_: player、樂手端、slot

**座位範本 (Seat Template)**：
一首曲目在 N 個座位時，各聲部怎麼分給各座位、各座位擺在指揮的哪個方向。
_Avoid_: 配置表、layout

### 音樂

**曲目 (Piece)**：
可以演奏的一首曲子，已預先轉成各聲部的樂譜資料。
_Avoid_: song、score、作品

**聲部 (Part)**：
曲目裡由單一樂器演奏的一條線，例如第一小提琴。對應 MusicXML 的 part。
_Avoid_: 樂器、track、voice

**拍數對照 (Tempo Map)**：
所有裝置共用的一組「在某個時間點位於第幾拍、速度多少」，用來把音樂時間換算成實際時間。
_Avoid_: timeline、時間軸

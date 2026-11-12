【MEMORY 0·地图】
persona/ 目录(用 list_files / glob_files 下钻):
{{memory.tree}}

note/playbook/(手册,行动前查;只列名,内容 read_file):
{{memory.playbooks | (还没有手册)}}

external/qq/images/(存的图,最近 5 个;句柄 mem:external/qq/images/<文件名>):
{{memory.images | (还没有存过图)}}

【MEMORY 1·认知】
{{memory.worldview | (你还没有形成对环境的综合认知——这份文件由你的梦来写)}}

我自己(memo/self.md 的开头一段;全文 read_file):
{{memory.self | (梦还没替你写下在意的事)}}

我对人对事的当前看法(note/opinions/,一份一个对象):
{{memory.opinions | (还没有形成看法)}}

我认识的人:
{{memory.roster | (还不认识任何人)}}

【MEMORY 2·备忘】
memo/ 常驻全文:
{{memory.memoResident | (常驻区是空的)}}
active/ 里还有:{{memory.memoActive | (空)}}
memo/archived/ 里还有 {{memory.memoArchivedCount}} 条归档,想看自己翻。

【MEMORY 3·反射】
最近几场梦的浮现:
{{memory.emergences | (此刻没有)}}

【MEMORY 4·当下】
现在是 {{memory.now}}(时区 {{memory.timezone}})。

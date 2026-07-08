⏺ 改动已完成。修复要点：                                                                      
  
  根因：Makefile 虽然在 PORT ?= $(or $(WEB_PORT),3000) 处定义了端口变量，但启动 node          
  dist/index.js 时没把它作为 WEB_PORT 环境变量传给进程，而 src/config.ts:44 读的是
  process.env.WEB_PORT，所以 node 一直监听 3000。                                             
                                                                  
  修改（Makefile）：                                                                          
  - _start-direct:90 — node dist/index.js → WEB_PORT=$(PORT) node dist/index.js
  - _start-pm2:71 — pm2 restart deepthink --update-env → WEB_PORT=$(PORT) pm2 restart         
  deepthink --update-env                                                              
  - 两处加上端口提示日志，start 目标 help 文本标注用法                                        
                                                                  
  使用方式：                                                                                  
                                                                                              
  make start PORT=4000        # 指定端口 4000 启动                                            
  make start WEB_PORT=4000    # 等价写法                                                      
  make stop PORT=4000         # 停指定端口                                                    
  make status PORT=4000       # 查指定端口状态                                                
                                                                                              
  不传 PORT 时仍走默认 3000，行为不变。当前 3000 端口被占用（旧进程 PID 49858），需要先 make  
  stop 或 make stop PORT=3000 再启动新端口。 
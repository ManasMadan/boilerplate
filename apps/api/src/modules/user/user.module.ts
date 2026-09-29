import { Module } from "@nestjs/common";
import { FilesModule } from "../files";
import { AvatarService } from "./avatar.service";
import { PhoneService } from "./phone.service";

@Module({
  imports: [FilesModule],
  providers: [PhoneService, AvatarService],
  exports: [PhoneService, AvatarService],
})
export class UserModule {}
